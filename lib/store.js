const QUEUE = "queue";
const strings = new Map();
const lists = new Map();

function memCleanup(key) {
  const entry = strings.get(key);
  if (entry && entry.expireAt && entry.expireAt < Date.now()) {
    strings.delete(key);
    return true;
  }
  return false;
}

const memory = {
  async get(key) {
    memCleanup(key);
    const entry = strings.get(key);
    return entry ? entry.value : null;
  },
  async set(key, value, exSeconds) {
    strings.set(key, {
      value,
      expireAt: exSeconds ? Date.now() + exSeconds * 1000 : null,
    });
  },
  async del(key) {
    strings.delete(key);
    lists.delete(key);
  },
  async rpush(key, value) {
    const arr = lists.get(key) || [];
    arr.push(value);
    lists.set(key, arr);
    return arr.length;
  },
  async lpop(key) {
    const arr = lists.get(key);
    if (!arr || arr.length === 0) return null;
    const v = arr.shift();
    if (arr.length === 0) lists.delete(key);
    return v;
  },
  async lrem(key, value) {
    const arr = lists.get(key);
    if (!arr) return;
    const filtered = arr.filter((v) => v !== value);
    if (filtered.length === 0) lists.delete(key);
    else lists.set(key, filtered);
  },
};

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKV = Boolean(REDIS_URL && REDIS_TOKEN);

let kvClient = null;
async function getKV() {
  if (!kvClient) {
    const { Redis } = await import("@upstash/redis");
    kvClient = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  }
  return kvClient;
}

const kvBackend = {
  async get(key) {
    const kv = await getKV();
    return kv.get(key);
  },
  async set(key, value, exSeconds) {
    const kv = await getKV();
    if (exSeconds) await kv.set(key, value, { ex: exSeconds });
    else await kv.set(key, value);
  },
  async del(key) {
    const kv = await getKV();
    await kv.del(key);
  },
  async rpush(key, value) {
    const kv = await getKV();
    return kv.rpush(key, value);
  },
  async lpop(key) {
    const kv = await getKV();
    const v = await kv.lpop(key);
    return v === undefined ? null : v;
  },
  async lrem(key, value) {
    const kv = await getKV();
    await kv.lrem(key, 0, value);
  },
};

const store = useKV ? kvBackend : memory;
store.backend = useKV ? "upstash-redis" : "memory";

module.exports = store;
