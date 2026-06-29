-- Run this once in Supabase: SQL Editor → New query → Run

CREATE TABLE IF NOT EXISTS store_kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS store_list (
  id BIGSERIAL PRIMARY KEY,
  list_key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_list_key_id ON store_list (list_key, id);
CREATE INDEX IF NOT EXISTS idx_store_kv_expires ON store_kv (expires_at) WHERE expires_at IS NOT NULL;

-- Optional: auto-delete expired KV rows (run via pg_cron or ignore for small apps)
-- DELETE FROM store_kv WHERE expires_at IS NOT NULL AND expires_at < NOW();
