const store = require("./store");

const QUEUE = "queue";
const SEEN_TTL = 60;
const PAIR_TTL = 3600;
const STALE_MS = 45000;

const mb = (id) => `mb:${id}`;
const pa = (id) => `pa:${id}`;
const seen = (id) => `seen:${id}`;

async function touch(id) {
  await store.set(seen(id), Date.now(), SEEN_TTL);
}

async function isStale(id) {
  const ts = await store.get(seen(id));
  if (!ts) return true;
  return Date.now() - Number(ts) > STALE_MS;
}

async function getQueue() {
  const q = await store.get(QUEUE);
  return Array.isArray(q) ? q : [];
}

async function saveQueue(q) {
  if (q.length) await store.set(QUEUE, q, PAIR_TTL);
  else await store.del(QUEUE);
}

async function enqueue(id) {
  const q = await getQueue();
  if (!q.includes(id)) q.push(id);
  await saveQueue(q);
  return q.length;
}

async function dequeue(id) {
  const q = await getQueue();
  const next = q.filter((x) => x !== id);
  await saveQueue(next);
}

async function popWaiter() {
  const q = await getQueue();
  while (q.length) {
    const cand = q.shift();
    await saveQueue(q);
    if (!cand) continue;
    if (await store.get(pa(cand))) continue;
    if (await isStale(cand)) continue;
    return cand;
  }
  return null;
}

async function drain(id) {
  const messages = [];
  for (let i = 0; i < 100; i++) {
    const msg = await store.lpop(mb(id));
    if (msg == null) break;
    messages.push(typeof msg === "string" ? safeParse(msg) : msg);
  }
  return messages;
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function pushMsg(toId, msg) {
  await store.rpush(mb(toId), msg);
}

async function pair(joinerId, waiterId) {
  // Clear any leftover signaling from a previous match so stale offers/ICE
  // candidates can't corrupt the new peer connection.
  await store.del(mb(joinerId));
  await store.del(mb(waiterId));

  // waiterId was waiting first → WebRTC initiator (sends offer)
  await store.set(pa(joinerId), waiterId, PAIR_TTL);
  await store.set(pa(waiterId), joinerId, PAIR_TTL);
  await dequeue(joinerId);
  await dequeue(waiterId);
  await pushMsg(waiterId, { type: "matched", initiator: true, partner: joinerId });
  await pushMsg(joinerId, { type: "matched", initiator: false, partner: waiterId });
}

async function matchmake(id, notifyWaiting = true) {
  await touch(id);

  const existing = await store.get(pa(id));
  if (existing && !(await isStale(existing))) {
    return { status: "matched", partner: existing, initiator: false };
  }
  if (existing) await store.del(pa(id));

  const cand = await popWaiter();
  if (cand && cand !== id) {
    await pair(id, cand);
    return { status: "matched", partner: cand, initiator: false };
  }

  const q = await getQueue();
  if (q.includes(id)) {
    return { status: "waiting", position: q.indexOf(id) + 1, waitingCount: q.length };
  }

  const pos = await enqueue(id);
  if (notifyWaiting) {
    await pushMsg(id, { type: "waiting", position: pos, waitingCount: pos });
  }
  return { status: "waiting", position: pos, waitingCount: pos };
}

async function leave(id, notify = true) {
  const partner = await store.get(pa(id));
  await store.del(pa(id));
  await dequeue(id);
  if (partner) {
    const partnersPartner = await store.get(pa(partner));
    if (partnersPartner === id) await store.del(pa(partner));
    if (notify) await pushMsg(partner, { type: "partner-left" });
  }
}

async function signal(id, data) {
  const partner = await store.get(pa(id));
  if (partner) await pushMsg(partner, { type: "signal", data });
}

async function chat(id, text) {
  const partner = await store.get(pa(id));
  if (!partner) return false;
  if (text === "__typing__") {
    await pushMsg(partner, { type: "typing", value: true });
    return true;
  }
  await pushMsg(partner, {
    type: "chat",
    text: String(text).slice(0, 2000),
    timestamp: Date.now(),
  });
  return true;
}

async function poll(id) {
  await touch(id);
  const messages = await drain(id);

  let partner = await store.get(pa(id));
  if (partner && (await isStale(partner))) {
    await leave(id, false);
    messages.push({ type: "partner-left" });
    partner = null;
  }

  let status;
  if (partner) {
    status = "matched";
  } else {
    const res = await matchmake(id, false);
    status = res.status;
    if (res.status === "matched") {
      messages.push(...(await drain(id)));
    } else {
      messages.push({
        type: "waiting",
        position: res.position,
        waitingCount: res.waitingCount,
      });
    }
  }

  const q = await getQueue();
  return { messages, status, waitingCount: q.length };
}

module.exports = { matchmake, leave, signal, chat, poll, touch };
