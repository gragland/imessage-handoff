export interface Env {
  DB: D1Database;
  REMOTE_THREAD_SOCKET?: DurableObjectNamespace;
  SENDBLUE_API_KEY?: string;
  SENDBLUE_SECRET_KEY?: string;
  SENDBLUE_WEBHOOK_SECRET?: string;
  SENDBLUE_FROM_NUMBER?: string;
  SENDBLUE_API_BASE_URL?: string;
  SENDBLUE_TYPING_DELAY_MS?: string;
}

export type RemoteReplyStatus = "pending" | "applied";

export interface RemoteThreadRow {
  id: string;
  owner_id: string;
  cwd: string;
  title: string | null;
  handoff_summary: string | null;
  status: string;
  remote_enabled: number;
  pairing_code: string | null;
  last_stop_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RemoteReplyRow {
  id: string;
  thread_id: string;
  external_id: string | null;
  body: string;
  media: string | null;
  media_group_id: string | null;
  media_index: number | null;
  status: RemoteReplyStatus;
  created_at: string;
  applied_at: string | null;
}

export interface PhoneBindingRow {
  phone_number: string;
  owner_id: string;
  active_thread_id: string | null;
  created_at: string;
  updated_at: string;
}
