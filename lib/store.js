// Shared state backend: Supabase Postgres in production, in-memory for local dev.
//
// Vercel/Supabase env vars:
//   SUPABASE_URL or STORAGE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY or STORAGE_SUPABASE_SERVICE_ROLE_KEY
// The service role key is server-side only — never expose it to browser code.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.STORAGE_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.STORAGE_SUPABASE_SERVICE_ROLE_KEY ||
  process.env.STORAGE_SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_STORAGE_SUPABASE_ANON_KEY;
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

// ---- In-memory fallback (local dev without Supabase) ----
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
    const filtered = arr.filter((v) => JSON.stringify(v) !== JSON.stringify(value));
    if (filtered.length === 0) lists.delete(key);
    else lists.set(key, filtered);
  },
};

// ---- Supabase backend ----
let sbClient = null;

function getSupabase() {
  if (!sbClient) {
    const { createClient } = require("@supabase/supabase-js");
    sbClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return sbClient;
}

const supabaseBackend = {
  async get(key) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("store_kv")
      .select("value, expires_at")
      .eq("key", key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.expires_at && new Date(data.expires_at) < new Date()) {
      await sb.from("store_kv").delete().eq("key", key);
      return null;
    }
    return data.value;
  },

  async set(key, value, exSeconds) {
    const sb = getSupabase();
    const row = {
      key,
      value,
      expires_at: exSeconds
        ? new Date(Date.now() + exSeconds * 1000).toISOString()
        : null,
    };
    const { error } = await sb.from("store_kv").upsert(row);
    if (error) throw error;
  },

  async del(key) {
    const sb = getSupabase();
    await sb.from("store_kv").delete().eq("key", key);
    await sb.from("store_list").delete().eq("list_key", key);
  },

  async rpush(key, value) {
    const sb = getSupabase();
    const { error } = await sb.from("store_list").insert({ list_key: key, value });
    if (error) throw error;
    const { count, error: countErr } = await sb
      .from("store_list")
      .select("*", { count: "exact", head: true })
      .eq("list_key", key);
    if (countErr) throw countErr;
    return count || 0;
  },

  async lpop(key) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("store_list")
      .select("id, value")
      .eq("list_key", key)
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    await sb.from("store_list").delete().eq("id", data.id);
    return data.value;
  },

  async lrem(key, value) {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("store_list")
      .select("id, value")
      .eq("list_key", key);
    if (error) throw error;
    if (!data) return;
    const target = JSON.stringify(value);
    for (const row of data) {
      if (JSON.stringify(row.value) === target) {
        await sb.from("store_list").delete().eq("id", row.id);
      }
    }
  },
};

const store = useSupabase ? supabaseBackend : memory;
store.backend = useSupabase ? "supabase" : "memory";

module.exports = store;
