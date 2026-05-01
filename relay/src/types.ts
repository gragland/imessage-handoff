export interface Env {
  // Cloudflare bindings and env vars available to the Worker at runtime.
  DB: D1Database;
  HANDOFF_SOCKET?: DurableObjectNamespace;
  SENDBLUE_API_KEY?: string;
  SENDBLUE_SECRET_KEY?: string;
  SENDBLUE_WEBHOOK_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string;
  SENDBLUE_API_BASE_URL?: string;
  SENDBLUE_TYPING_DELAY_MS?: string;
}

export type HandoffReplyStatus = "pending" | "applied";

// D1 table row shapes. These are intentionally close to the SQL schema so the
// relay code makes it obvious which fields are durable metadata.

export interface HandoffThreadRow {
  // One local Codex thread that may be controlled from iMessage.
  id: string;
  owner_id: string;
  cwd: string;
  title: string | null;
  handoff_summary: string | null;
  status: string;
  handoff_enabled: number;
  pairing_code: string | null;
  pairing_code_expires_at: string | null;
  last_stop_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HandoffReplyRow {
  // Pending/applied inbound reply metadata. With the DO buffer enabled, bodies
  // and media live in memory and are scrubbed on claim.
  id: string;
  thread_id: string;
  external_id: string | null;
  body: string;
  media: string | null;
  media_group_id: string | null;
  media_index: number | null;
  status: HandoffReplyStatus;
  created_at: string;
  applied_at: string | null;
}

export interface PhoneBindingRow {
  // Links one iMessage phone number to one local install owner. active_thread_id
  // controls which Codex thread receives normal inbound texts.
  phone_number: string;
  owner_id: string;
  active_thread_id: string | null;
  contact_card_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PairingAttemptLimitRow {
  // Failed code-shaped pairing attempts from one phone number.
  phone_number: string;
  failed_count: number;
  window_start_at: string;
  blocked_until: string | null;
  updated_at: string;
}
