-- Pairing codes are the handoff boundary from iMessage into a local Codex
-- thread. Expire codes and rate-limit failed code-shaped guesses per phone.
ALTER TABLE handoff_threads ADD COLUMN pairing_code_expires_at TEXT;

CREATE TABLE IF NOT EXISTS pairing_attempt_limits (
  phone_number TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL,
  window_start_at TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);
