const store = require("./store");

const QUEUE = "queue";
const SEEN_TTL = 30; // seconds the heartbeat key lives
const PAIR_TTL = 3600; // seconds a pairing mapping lives
const STALE_MS = 15000; // a peer not seen in this long is considered gone

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

async function matchmake(id) {
  await touch(id);

  const existing = await store.get(pa(id));
  if (existing) return { status: "matched" };

  await store.lrem(QUEUE, id);

  for (let i = 0; i < 25; i++) {
    const cand = await store.lpop(QUEUE);
    if (cand == null) {
      await store.rpush(QUEUE, id);
      return { status: "waiting" };
    }
    if (cand === id) continue;
    if (await store.get(pa(cand))) continue; // already paired
    if (await isStale(cand)) continue; // dead waiter, drop

    await store.set(pa(id), cand, PAIR_TTL);
    await store.set(pa(cand), id, PAIR_TTL);
    await pushMsg(cand, { type: "matched", initiator: true, partner: id });
    await pushMsg(id, { type: "matched", initiator: false, partner: cand });
    return { status: "matched" };
  }

  await store.rpush(QUEUE, id);
  return { status: "waiting" };
}

async function leave(id, notify = true) {
  const partner = await store.get(pa(id));
  await store.del(pa(id));
  await store.lrem(QUEUE, id);
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

async function poll(id) {
  await touch(id);
  const messages = await drain(id);

  const partner = await store.get(pa(id));
  if (partner) {
    if (await isStale(partner)) {
      await leave(id, false);
      messages.push({ type: "partner-left" });
    }
  } else {
    const res = await matchmake(id);
    if (res.status === "matched") {
      const more = await drain(id);
      messages.push(...more);
    }
  }

  return { messages };
}

module.exports = { matchmake, leave, signal, poll, touch };
