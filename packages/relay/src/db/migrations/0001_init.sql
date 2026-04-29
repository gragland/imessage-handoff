-- One row per local Codex thread that has been enabled for Remote Control.
-- This table stores routing/status metadata, not conversation history.
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

-- Pairing codes are short-lived codes the user texts from iMessage to bind
-- their phone number to the local install token owner.
CREATE UNIQUE INDEX IF NOT EXISTS remote_threads_pairing_code_idx
  ON remote_threads(pairing_code);

-- A phone binding decides which owner and active Codex thread an inbound
-- iMessage should route to.
CREATE TABLE IF NOT EXISTS phone_bindings (
  phone_number TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  active_thread_id TEXT REFERENCES remote_threads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS phone_bindings_owner_id_idx
  ON phone_bindings(owner_id);
