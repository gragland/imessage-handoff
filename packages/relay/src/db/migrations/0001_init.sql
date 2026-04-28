CREATE TABLE IF NOT EXISTS remote_threads (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT,
  handoff_summary TEXT,
  status TEXT NOT NULL DEFAULT 'enabled',
  remote_enabled INTEGER NOT NULL DEFAULT 1,
  pairing_code TEXT,
  last_stop_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS remote_threads_owner_enabled_idx
  ON remote_threads(owner_id, remote_enabled, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS remote_threads_pairing_code_idx
  ON remote_threads(pairing_code);

CREATE TABLE IF NOT EXISTS remote_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES remote_threads(id) ON DELETE CASCADE,
  external_id TEXT,
  body TEXT NOT NULL,
  media TEXT,
  media_group_id TEXT,
  media_index INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS remote_replies_pending_idx
  ON remote_replies(thread_id, status, created_at);

CREATE INDEX IF NOT EXISTS remote_replies_media_group_idx
  ON remote_replies(thread_id, status, media_group_id, media_index);

CREATE UNIQUE INDEX IF NOT EXISTS remote_replies_external_id_idx
  ON remote_replies(external_id);

CREATE TABLE IF NOT EXISTS phone_bindings (
  phone_number TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  active_thread_id TEXT REFERENCES remote_threads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS phone_bindings_owner_id_idx
  ON phone_bindings(owner_id);
