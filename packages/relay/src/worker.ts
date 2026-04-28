import type { Env, PhoneBindingRow, RemoteReplyRow, RemoteThreadRow } from "./types.ts";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};
const IMESSAGE_REQUIRED_MESSAGE = "Remote Control only supports phone numbers that use iMessage for now.";
const THREAD_LIST_COMMANDS = new Set(["list", "threads"]);
const NO_REMOTE_THREADS_MESSAGE = "You have no remote codex threads";
const SWITCH_RANGE_MESSAGE = "Text threads to see active remote threads.";
const MEDIA_GROUP_QUIET_MS = 3000;

interface RegisterBody {
  cwd?: unknown;
  title?: unknown;
  handoffSummary?: unknown;
}

interface StatusBody {
  cwd?: unknown;
  lastAssistantMessage?: unknown;
  generatedImages?: unknown;
  status?: unknown;
  createdAt?: unknown;
}

interface SendblueWebhookBody {
  content?: unknown;
  is_outbound?: unknown;
  status?: unknown;
  message_handle?: unknown;
  from_number?: unknown;
  number?: unknown;
  media_url?: unknown;
}

type JsonRecord = Record<string, unknown>;

interface GeneratedImageInput {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

interface ReplyMedia {
  url: string;
}

export class RemoteThreadSocket {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return error(426, "WebSocket upgrade required.");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const text = typeof message === "string"
      ? message
      : new TextDecoder().decode(message);
    let parsed: JsonRecord | null = null;
    try {
      const value = JSON.parse(text) as unknown;
      parsed = isRecord(value) ? value : null;
    } catch {
      parsed = null;
    }

    ws.send(JSON.stringify({
      type: "ack",
      received: true,
      receivedAt: nowIso(),
      messageType: optionalString(parsed?.type),
    }));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    ws.close(code, reason);
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers,
    },
  });
}

function error(status: number, message: string) {
  return json({ error: message }, { status });
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function authToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
}

function authTokenFromRequestOrUrl(request: Request) {
  return authToken(request) || new URL(request.url).searchParams.get("token")?.trim() || "";
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeInstallToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `rc_${bytesToHex(bytes)}`;
}

async function ownerIdFromToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`remote-control:${token}`));
  return bytesToHex(new Uint8Array(digest));
}

async function requireOwnerId(request: Request) {
  const token = authToken(request);
  if (!token) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  return ownerIdFromToken(token);
}

function makePairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function findThread(env: Env, threadId: string) {
  return env.DB.prepare("SELECT * FROM remote_threads WHERE id = ?")
    .bind(threadId)
    .first<RemoteThreadRow>();
}

function assertAuthorized(thread: RemoteThreadRow | null, ownerId: string) {
  if (!thread) {
    throw Object.assign(new Error("Thread not found."), { status: 404 });
  }
  if (ownerId !== thread.owner_id) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  return thread;
}

function publicThread(thread: RemoteThreadRow, pendingReplies: Array<Pick<RemoteReplyRow, "id" | "body" | "media" | "created_at">> = []) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    title: thread.title,
    handoffSummary: thread.handoff_summary,
    status: thread.status,
    remoteEnabled: thread.remote_enabled === 1,
    pairingCode: thread.pairing_code,
    lastStopAt: thread.last_stop_at,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    pendingReplies: pendingReplies.map((reply) => ({
      id: reply.id,
      body: reply.body,
      media: parseReplyMedia(reply.media),
      createdAt: reply.created_at,
    })),
  };
}

async function handleRegister(request: Request, env: Env, threadId: string) {
  const body = await readJsonBody<RegisterBody>(request);
  const ownerId = await requireOwnerId(request);
  const cwd = requireString(body.cwd, "cwd");
  const title = optionalString(body.title);
  const handoffSummary = optionalString(body.handoffSummary);
  const existingThread = await findThread(env, threadId);
  if (existingThread) {
    assertAuthorized(existingThread, ownerId);
  }
  const existingBinding = await findPhoneBindingForOwner(env, ownerId);
  const pairingRequired = !existingBinding;
  const pairingCode = pairingRequired ? makePairingCode() : null;
  const createdAt = nowIso();

  await env.DB.prepare(
    `INSERT INTO remote_threads (
      id, owner_id, cwd, title, handoff_summary, status, remote_enabled, pairing_code,
      last_stop_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'enabled', 1, ?, NULL, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_id = excluded.owner_id,
      cwd = excluded.cwd,
      title = excluded.title,
      handoff_summary = excluded.handoff_summary,
      status = 'enabled',
      remote_enabled = 1,
      pairing_code = excluded.pairing_code,
      updated_at = excluded.updated_at`,
  ).bind(threadId, ownerId, cwd, title, handoffSummary, pairingCode, createdAt, createdAt).run();

  await env.DB.prepare(
    "UPDATE remote_threads SET pairing_code = NULL, updated_at = ? WHERE owner_id = ? AND id != ?",
  ).bind(createdAt, ownerId, threadId).run();

  if (existingBinding) {
    await env.DB.prepare(
      "UPDATE phone_bindings SET active_thread_id = ?, updated_at = ? WHERE owner_id = ?",
    ).bind(threadId, createdAt, ownerId).run();
    const registeredThread = await findThread(env, threadId);
    if (registeredThread) {
      await sendControlMessage(env, existingBinding.phone_number, remoteActivationMessage(registeredThread));
    }
  }

  return json({
    id: threadId,
    sendblueNumber: env.SENDBLUE_FROM_NUMBER || "+16452468235",
    paired: Boolean(existingBinding),
    pairingRequired,
    pairingCode,
    skipNextStatusSend: Boolean(existingBinding),
  });
}

function handleCreateInstallation() {
  return json({ token: makeInstallToken() });
}

async function findPhoneBinding(env: Env, phoneNumber: string) {
  return env.DB.prepare("SELECT phone_number, owner_id, active_thread_id, created_at, updated_at FROM phone_bindings WHERE phone_number = ?")
    .bind(phoneNumber)
    .first<PhoneBindingRow>();
}

async function findPhoneBindingForOwner(env: Env, ownerId: string) {
  return env.DB.prepare("SELECT phone_number, owner_id, active_thread_id, created_at, updated_at FROM phone_bindings WHERE owner_id = ?")
    .bind(ownerId)
    .first<PhoneBindingRow>();
}

async function findPairingThread(env: Env, pairingCode: string) {
  return env.DB.prepare("SELECT * FROM remote_threads WHERE pairing_code = ? AND remote_enabled = 1")
    .bind(pairingCode)
    .first<RemoteThreadRow>();
}

async function findExternalReply(env: Env, externalId: string) {
  return env.DB.prepare("SELECT id FROM remote_replies WHERE external_id = ?")
    .bind(externalId)
    .first<Pick<RemoteReplyRow, "id">>();
}

async function findPhoneForThread(env: Env, threadId: string) {
  return env.DB.prepare("SELECT phone_number, owner_id, active_thread_id, created_at, updated_at FROM phone_bindings WHERE active_thread_id = ?")
    .bind(threadId)
    .first<PhoneBindingRow>();
}

async function listEnabledThreadsForOwner(env: Env, ownerId: string) {
  const { results } = await env.DB.prepare(
    `SELECT *
      FROM remote_threads
      WHERE owner_id = ? AND remote_enabled = 1
      ORDER BY updated_at DESC, created_at DESC, id DESC`,
  ).bind(ownerId).all<RemoteThreadRow>();
  return results;
}

function threadDisplayName(thread: RemoteThreadRow) {
  if (thread.title?.trim()) {
    return thread.title.trim();
  }
  const cwdName = thread.cwd.split("/").filter(Boolean).at(-1);
  return cwdName || thread.id;
}

function quotedThreadDisplayName(thread: RemoteThreadRow) {
  return `"${threadDisplayName(thread).replaceAll('"', "'")}"`;
}

function remoteActivationMessage(thread: RemoteThreadRow) {
  const connectionLine = thread.title?.trim()
    ? `You’re connected to ${quotedThreadDisplayName(thread)} on Codex.`
    : "You’re connected to this Codex thread.";
  return [
    connectionLine,
    thread.handoff_summary?.trim() || null,
    "What do you want to do next?",
  ].filter(Boolean).join("\n\n");
}

function formatThreadList(threads: RemoteThreadRow[], activeThreadId: string | null) {
  if (threads.length === 0) {
    return NO_REMOTE_THREADS_MESSAGE;
  }
  return [
    "Remote threads:",
    "",
    ...threads.map((thread, index) => {
      const current = thread.id === activeThreadId ? " (current)" : "";
      return `${index + 1}. ${threadDisplayName(thread)}${current}`;
    }),
    "",
    "Reply with a number to switch.",
  ].join("\n");
}

function parseThreadSelection(content: string) {
  const trimmed = content.trim();
  return /^[1-9]\d*$/.test(trimmed) ? Number(trimmed) : null;
}

function parseReplyMedia(value: string | null) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (!isRecord(item)) {
        return [];
      }
      const url = optionalString(item.url);
      return url ? [{ url }] : [];
    });
  } catch {
    return [];
  }
}

function replyMediaJson(mediaUrl: string | null) {
  return mediaUrl ? JSON.stringify([{ url: mediaUrl } satisfies ReplyMedia]) : null;
}

function sendblueMediaGroup(externalId: string | null, mediaUrl: string | null) {
  if (!externalId || !mediaUrl) {
    return { mediaGroupId: null, mediaIndex: null };
  }
  const match = externalId.match(/^(.*)_(\d+)$/);
  return {
    mediaGroupId: match ? match[1] : externalId,
    mediaIndex: match ? Number(match[2]) : 0,
  };
}

function combineReplyRows(rows: RemoteReplyRow[]) {
  const ordered = [...rows].sort((a, b) => (
    (a.media_index ?? 0) - (b.media_index ?? 0)
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id)
  ));
  const first = ordered[0];
  const body = ordered.find((reply) => reply.body.trim())?.body ?? "";
  const media = ordered.flatMap((reply) => parseReplyMedia(reply.media));
  return first ? {
    id: first.id,
    body,
    media,
    createdAt: first.created_at,
  } : null;
}

function eligiblePendingReplies(rows: RemoteReplyRow[]) {
  const groups = new Map<string, RemoteReplyRow[]>();
  const eligible: Array<ReturnType<typeof combineReplyRows>> = [];
  const cutoff = Date.now() - MEDIA_GROUP_QUIET_MS;

  for (const row of rows) {
    if (!row.media_group_id) {
      eligible.push(combineReplyRows([row]));
      continue;
    }
    groups.set(row.media_group_id, [...(groups.get(row.media_group_id) ?? []), row]);
  }

  for (const groupRows of groups.values()) {
    const newest = Math.max(...groupRows.map((row) => Date.parse(row.created_at)).filter(Number.isFinite));
    if (!Number.isFinite(newest) || newest <= cutoff) {
      eligible.push(combineReplyRows(groupRows));
    }
  }

  return eligible
    .filter(Boolean)
    .sort((a, b) => String(a?.createdAt).localeCompare(String(b?.createdAt)));
}

async function sendControlMessage(env: Env, phoneNumber: string, message: string) {
  try {
    await sendSendblueMessage(env, phoneNumber, message);
  } catch (caught) {
    console.warn("Sendblue control message failed", caught);
  }
}

async function setActiveThreadForOwner(env: Env, ownerId: string, threadId: string | null) {
  await env.DB.prepare(
    "UPDATE phone_bindings SET active_thread_id = ?, updated_at = ? WHERE owner_id = ?",
  ).bind(threadId, nowIso(), ownerId).run();
}

async function touchThread(env: Env, threadId: string) {
  await env.DB.prepare("UPDATE remote_threads SET updated_at = ? WHERE id = ?")
    .bind(nowIso(), threadId)
    .run();
}

function sendblueApiBaseUrl(env: Env) {
  return (env.SENDBLUE_API_BASE_URL || "https://api.sendblue.com/api").replace(/\/+$/, "");
}

function sendblueAuthHeaders(env: Env) {
  const apiKey = env.SENDBLUE_API_KEY?.trim();
  const secretKey = env.SENDBLUE_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) {
    throw new Error("Sendblue credentials are missing.");
  }
  return {
    "content-type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": secretKey,
  };
}

function sendblueAuthOnlyHeaders(env: Env) {
  const apiKey = env.SENDBLUE_API_KEY?.trim();
  const secretKey = env.SENDBLUE_SECRET_KEY?.trim();
  if (!apiKey || !secretKey) {
    throw new Error("Sendblue credentials are missing.");
  }
  return {
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": secretKey,
  };
}

function sendblueTypingDelayMs(env: Env) {
  const raw = env.SENDBLUE_TYPING_DELAY_MS;
  if (raw === undefined || raw === null || raw === "") {
    return 2000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readSendblueJson(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Sendblue API returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

function assertSendblueAccepted(body: unknown) {
  const wrapper = isRecord(body) ? body : {};
  const payload = isRecord(wrapper.data) ? wrapper.data : wrapper;
  const status = optionalString(payload.status) ?? optionalString(wrapper.status);
  const normalizedStatus = status?.toUpperCase();
  const messageHandle = optionalString(payload.message_handle) ?? optionalString(wrapper.message_handle);
  const errorCode = payload.error_code ?? wrapper.error_code;
  const errorMessage = optionalString(payload.error_message)
    ?? optionalString(wrapper.error_message)
    ?? optionalString(wrapper.message);

  if (normalizedStatus === "ERROR" || normalizedStatus === "DECLINED") {
    throw new Error(`Sendblue rejected message: ${errorMessage ?? normalizedStatus}`);
  }
  if (errorCode !== null && errorCode !== undefined && errorCode !== 0 && errorCode !== "0") {
    throw new Error(`Sendblue rejected message: ${errorMessage ?? `error_code ${String(errorCode)}`}`);
  }
  if (!messageHandle) {
    throw new Error("Sendblue response did not include a message_handle.");
  }
  return {
    messageHandle,
    status: normalizedStatus ?? "ACCEPTED",
  };
}

function mediaUrlFromSendblue(body: unknown) {
  const wrapper = isRecord(body) ? body : {};
  const payload = isRecord(wrapper.data) ? wrapper.data : wrapper;
  const mediaUrl = optionalString(payload.media_url)
    ?? optionalString(payload.url)
    ?? optionalString(payload.mediaUrl)
    ?? optionalString(wrapper.media_url);
  if (!mediaUrl) {
    throw new Error("Sendblue media upload response did not include a media_url.");
  }
  return mediaUrl;
}

function formatForSendblue(content: string) {
  return content
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function parseGeneratedImages(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  const images: GeneratedImageInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const dataBase64 = optionalString(item.dataBase64);
    if (!dataBase64) {
      continue;
    }
    images.push({
      dataBase64,
      filename: optionalString(item.filename) ?? "image.png",
      mimeType: optionalString(item.mimeType) ?? "image/png",
    });
  }
  return images.slice(0, 20);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function uploadSendblueMedia(env: Env, image: GeneratedImageInput) {
  const form = new FormData();
  const bytes = base64ToBytes(image.dataBase64);
  form.append("file", new Blob([bytes], { type: image.mimeType }), image.filename);

  const response = await fetch(`${sendblueApiBaseUrl(env)}/upload-file`, {
    method: "POST",
    headers: sendblueAuthOnlyHeaders(env),
    body: form,
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue media API ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return mediaUrlFromSendblue(body);
}

async function sendSendblueMessage(env: Env, number: string, content: string | null, mediaUrl: string | null = null) {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+16452468235";
  const payload: Record<string, string> = {
    number,
    from_number: fromNumber,
  };
  if (content) {
    payload.content = content;
  }
  if (mediaUrl) {
    payload.media_url = mediaUrl;
  }

  const response = await fetch(`${sendblueApiBaseUrl(env)}/send-message`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify(payload),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue API ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return assertSendblueAccepted(body);
}

async function sendSendblueCarousel(env: Env, number: string, mediaUrls: string[]) {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+16452468235";

  const response = await fetch(`${sendblueApiBaseUrl(env)}/send-carousel`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify({
      number,
      from_number: fromNumber,
      media_urls: mediaUrls,
    }),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue carousel API ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  return assertSendblueAccepted(body);
}

async function sendStatusNotification(
  env: Env,
  number: string,
  lastAssistantMessage: string | null,
  images: GeneratedImageInput[],
) {
  const formattedText = lastAssistantMessage ? formatForSendblue(lastAssistantMessage) : null;
  const mediaUrls = [];
  for (const image of images) {
    mediaUrls.push(await uploadSendblueMedia(env, image));
  }

  if (mediaUrls.length === 0) {
    return formattedText ? sendSendblueMessage(env, number, formattedText) : null;
  }
  if (mediaUrls.length === 1) {
    return sendSendblueMessage(env, number, formattedText, mediaUrls[0]);
  }
  if (formattedText) {
    await sendSendblueMessage(env, number, formattedText);
  }
  return sendSendblueCarousel(env, number, mediaUrls);
}

async function sendSendblueTypingIndicator(env: Env, number: string) {
  const fromNumber = env.SENDBLUE_FROM_NUMBER?.trim() || "+16452468235";
  const response = await fetch(`${sendblueApiBaseUrl(env)}/send-typing-indicator`, {
    method: "POST",
    headers: sendblueAuthHeaders(env),
    body: JSON.stringify({
      number,
      from_number: fromNumber,
    }),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue typing API ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const indicatorStatus = isRecord(payload) ? optionalString(payload.status)?.toUpperCase() : null;
  if (indicatorStatus === "ERROR") {
    const message = isRecord(payload) ? optionalString(payload.error_message) : null;
    throw new Error(`Sendblue typing indicator failed: ${message ?? "ERROR"}`);
  }
}

async function lookupSendblueService(env: Env, number: string) {
  const url = new URL(`${sendblueApiBaseUrl(env)}/evaluate-service`);
  url.searchParams.set("number", number);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: sendblueAuthOnlyHeaders(env),
  });
  const body = await readSendblueJson(response);
  if (!response.ok) {
    throw new Error(`Sendblue lookup API ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
  const payload = isRecord(body) && isRecord(body.data) ? body.data : body;
  const service = isRecord(payload) ? optionalString(payload.service) : null;
  if (service !== "iMessage" && service !== "SMS") {
    return null;
  }
  return service;
}

async function lookupPairingService(env: Env, phoneNumber: string) {
  try {
    return await lookupSendblueService(env, phoneNumber);
  } catch {
    // Pairing should remain available if Sendblue's lookup endpoint is temporarily unavailable.
  }
  return null;
}

async function handleStatus(request: Request, env: Env, threadId: string) {
  const body = await readJsonBody<StatusBody>(request);
  const ownerId = await requireOwnerId(request);
  const thread = assertAuthorized(await findThread(env, threadId), ownerId);
  const updatedAt = nowIso();
  const lastStopAt = optionalString(body.createdAt) ?? updatedAt;
  const status = optionalString(body.status) ?? "stopped";
  const cwd = optionalString(body.cwd) ?? thread.cwd;
  const lastAssistantMessage = optionalString(body.lastAssistantMessage);
  const generatedImages = parseGeneratedImages(body.generatedImages);
  let notification: JsonRecord | null = null;

  await env.DB.prepare(
    `UPDATE remote_threads
      SET cwd = ?,
          status = ?,
          last_stop_at = ?,
          updated_at = ?
      WHERE id = ?`,
  ).bind(cwd, status, lastStopAt, updatedAt, threadId).run();

  if (lastAssistantMessage || generatedImages.length > 0) {
    const binding = await findPhoneForThread(env, threadId);
    if (binding) {
      try {
        const sendResult = await sendStatusNotification(env, binding.phone_number, lastAssistantMessage, generatedImages);
        if (sendResult) {
          notification = {
            sent: true,
            status: sendResult.status,
            messageHandle: sendResult.messageHandle,
          };
        }
      } catch (caught) {
        const errorMessage = caught instanceof Error ? caught.message : String(caught);
        notification = {
          sent: false,
          status: "ERROR",
          error: errorMessage,
        };
        console.warn("Sendblue status notification failed", caught);
        // Remote status publishing should never break the local Stop hook.
      }
    } else {
      notification = {
        sent: false,
        status: "NO_BINDING",
      };
    }
  }

  return json({ ok: true, notification });
}

async function handlePending(request: Request, env: Env, threadId: string) {
  const ownerId = await requireOwnerId(request);
  assertAuthorized(await findThread(env, threadId), ownerId);
  const { results } = await env.DB.prepare(
    `SELECT *
      FROM remote_replies
      WHERE thread_id = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 50`,
  ).bind(threadId).all<RemoteReplyRow>();

  return json({
    replies: eligiblePendingReplies(results).slice(0, 10),
  });
}

async function handleClaim(request: Request, env: Env, threadId: string, replyId: string) {
  const ownerId = await requireOwnerId(request);
  assertAuthorized(await findThread(env, threadId), ownerId);
  const appliedAt = nowIso();
  const selectedReply = await env.DB.prepare(
    "SELECT * FROM remote_replies WHERE id = ? AND thread_id = ? AND status = 'pending'",
  ).bind(replyId, threadId).first<RemoteReplyRow>();

  if (!selectedReply) {
    return json({ ok: false, error: "Reply is not pending." }, { status: 409 });
  }

  let replyRows = [selectedReply];
  let reply = combineReplyRows(replyRows);
  let result: D1Result;

  if (selectedReply.media_group_id) {
    const { results } = await env.DB.prepare(
      `SELECT *
        FROM remote_replies
        WHERE thread_id = ? AND media_group_id = ? AND status = 'pending'
        ORDER BY media_index ASC, created_at ASC`,
    ).bind(threadId, selectedReply.media_group_id).all<RemoteReplyRow>();
    replyRows = results;
    reply = combineReplyRows(replyRows);
    // Preserve the external Sendblue ids for retry dedupe, but scrub message
    // contents as soon as local Codex has fetched them.
    result = await env.DB.prepare(
      `UPDATE remote_replies
        SET status = 'applied',
            body = '',
            media = NULL,
            applied_at = ?
        WHERE thread_id = ? AND media_group_id = ? AND status = 'pending'`,
    ).bind(appliedAt, threadId, selectedReply.media_group_id).run();
  } else {
    // Preserve the external Sendblue id for retry dedupe, but scrub message
    // contents as soon as local Codex has fetched it.
    result = await env.DB.prepare(
      `UPDATE remote_replies
        SET status = 'applied',
            body = '',
            media = NULL,
            applied_at = ?
        WHERE id = ? AND thread_id = ? AND status = 'pending'`,
    ).bind(appliedAt, replyId, threadId).run();
  }

  if (!result.meta || result.meta.changes < 1) {
    return json({ ok: false, error: "Reply is not pending." }, { status: 409 });
  }

  const binding = await findPhoneForThread(env, threadId);
  if (binding) {
    try {
      const delayMs = sendblueTypingDelayMs(env);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      await sendSendblueTypingIndicator(env, binding.phone_number);
    } catch (caught) {
      console.warn("Sendblue typing indicator failed", caught);
    }
  }

  return json({
    ok: true,
    reply,
  });
}

async function insertRemoteReply(
  env: Env,
  threadId: string,
  body: string,
  externalId: string | null,
  status: "pending" | "applied" = "pending",
  mediaUrl: string | null = null,
) {
  const id = makeId("reply");
  const createdAt = nowIso();
  const isTombstone = status === "applied";
  // Control messages such as pairing and thread switching only need an external-id
  // tombstone for dedupe; their content is not retained.
  const storedBody = isTombstone ? "" : body;
  const media = isTombstone ? null : replyMediaJson(mediaUrl);
  const { mediaGroupId, mediaIndex } = sendblueMediaGroup(externalId, mediaUrl);
  await env.DB.prepare(
    `INSERT INTO remote_replies (
      id, thread_id, external_id, body, media, media_group_id, media_index, status, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, threadId, externalId, storedBody, media, mediaGroupId, mediaIndex, status, createdAt, isTombstone ? createdAt : null).run();
  return id;
}

async function handleSendblueWebhook(request: Request, env: Env) {
  const expectedSecret = env.SENDBLUE_WEBHOOK_SECRET?.trim();
  if (!expectedSecret) {
    return error(500, "Sendblue webhook secret is not configured.");
  }
  if (request.headers.get("sb-signing-secret") !== expectedSecret) {
    return error(401, "Unauthorized.");
  }

  const body = await readJsonBody<SendblueWebhookBody>(request);
  const content = optionalString(body.content);
  const mediaUrl = optionalString(body.media_url);
  const fromNumber = optionalString(body.from_number) ?? optionalString(body.number);
  const externalId = optionalString(body.message_handle);
  const status = optionalString(body.status);
  const isOutbound = body.is_outbound === true || String(body.is_outbound).toLowerCase() === "true";

  if (isOutbound || status?.toUpperCase() !== "RECEIVED" || (!content && !mediaUrl) || !fromNumber) {
    return json({ ok: true, ignored: true });
  }
  if (externalId && await findExternalReply(env, externalId)) {
    return json({ ok: true, duplicate: true });
  }

  const pairingThread = content ? await findPairingThread(env, content.toUpperCase()) : null;
  if (pairingThread) {
    const now = nowIso();
    const service = await lookupPairingService(env, fromNumber);
    if (service === "SMS") {
      if (externalId) {
        await insertRemoteReply(env, pairingThread.id, content ?? "", externalId, "applied");
      }
      await sendControlMessage(env, fromNumber, IMESSAGE_REQUIRED_MESSAGE);
      return json({ ok: true, paired: false, unsupportedService: "SMS" });
    }
    await env.DB.prepare(
      "DELETE FROM phone_bindings WHERE owner_id = ? AND phone_number != ?",
    ).bind(pairingThread.owner_id, fromNumber).run();
    await env.DB.prepare(
      `INSERT INTO phone_bindings (phone_number, owner_id, active_thread_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(phone_number) DO UPDATE SET
          owner_id = excluded.owner_id,
          active_thread_id = excluded.active_thread_id,
          updated_at = excluded.updated_at`,
    ).bind(fromNumber, pairingThread.owner_id, pairingThread.id, now, now).run();
    await env.DB.prepare(
      "UPDATE remote_threads SET pairing_code = NULL, updated_at = ? WHERE id = ?",
    ).bind(now, pairingThread.id).run();
    if (externalId) {
      await insertRemoteReply(env, pairingThread.id, content ?? "", externalId, "applied");
    }
    try {
      await sendSendblueMessage(env, fromNumber, remoteActivationMessage(pairingThread));
    } catch {
      // Pairing should still succeed if the confirmation send is temporarily unavailable.
    }
    return json({ ok: true, paired: true, threadId: pairingThread.id, service });
  }

  const binding = await findPhoneBinding(env, fromNumber);
  if (!binding) {
    return json({ ok: true, ignored: true });
  }

  const command = content?.trim().toLowerCase() ?? "";
  if (!mediaUrl && THREAD_LIST_COMMANDS.has(command)) {
    const threads = await listEnabledThreadsForOwner(env, binding.owner_id);
    await sendControlMessage(env, fromNumber, formatThreadList(threads, binding.active_thread_id));
    if (externalId && binding.active_thread_id) {
      await insertRemoteReply(env, binding.active_thread_id, content ?? "", externalId, "applied");
    }
    return json({ ok: true, command: "list", threadCount: threads.length });
  }

  const selection = content ? parseThreadSelection(content) : null;
  if (!mediaUrl && content && selection !== null) {
    const threads = await listEnabledThreadsForOwner(env, binding.owner_id);
    const selected = threads[selection - 1];
    if (!selected) {
      await sendControlMessage(env, fromNumber, SWITCH_RANGE_MESSAGE);
      if (externalId && binding.active_thread_id) {
        await insertRemoteReply(env, binding.active_thread_id, content, externalId, "applied");
      }
      return json({ ok: true, command: "switch", switched: false });
    }
    await setActiveThreadForOwner(env, binding.owner_id, selected.id);
    await sendControlMessage(env, fromNumber, `Switched to ${quotedThreadDisplayName(selected)}.`);
    if (externalId) {
      await insertRemoteReply(env, selected.id, content, externalId, "applied");
    }
    return json({ ok: true, command: "switch", switched: true, threadId: selected.id });
  }

  if (!binding.active_thread_id) {
    await sendControlMessage(env, fromNumber, NO_REMOTE_THREADS_MESSAGE);
    return json({ ok: true, ignored: true, noActiveThread: true });
  }

  const activeThread = await findThread(env, binding.active_thread_id);
  if (!activeThread || activeThread.remote_enabled !== 1) {
    await setActiveThreadForOwner(env, binding.owner_id, null);
    await sendControlMessage(env, fromNumber, NO_REMOTE_THREADS_MESSAGE);
    return json({ ok: true, ignored: true, noActiveThread: true });
  }

  const replyId = await insertRemoteReply(env, binding.active_thread_id, content ?? "", externalId, "pending", mediaUrl);
  await touchThread(env, binding.active_thread_id);
  return json({ ok: true, replyId });
}

async function handleGetThread(request: Request, env: Env, threadId: string) {
  const ownerId = await requireOwnerId(request);
  const thread = assertAuthorized(await findThread(env, threadId), ownerId);
  const { results } = await env.DB.prepare(
    `SELECT id, body, media, created_at
      FROM remote_replies
      WHERE thread_id = ? AND status = 'pending'
      ORDER BY created_at ASC`,
  ).bind(threadId).all<Pick<RemoteReplyRow, "id" | "body" | "media" | "created_at">>();
  return json(publicThread(thread, results));
}

async function handleStopThread(request: Request, env: Env, threadId: string) {
  const ownerId = await requireOwnerId(request);
  const thread = assertAuthorized(await findThread(env, threadId), ownerId);
  const stoppedAt = nowIso();

  await env.DB.prepare(
    `UPDATE remote_threads
      SET status = 'stopped',
          remote_enabled = 0,
          pairing_code = NULL,
          updated_at = ?
      WHERE id = ?`,
  ).bind(stoppedAt, threadId).run();

  let nextActiveThreadId: string | null = null;
  const binding = await findPhoneBindingForOwner(env, thread.owner_id);
  if (binding?.active_thread_id === threadId) {
    const remaining = await listEnabledThreadsForOwner(env, thread.owner_id);
    nextActiveThreadId = remaining[0]?.id ?? null;
    await setActiveThreadForOwner(env, thread.owner_id, nextActiveThreadId);
  } else {
    nextActiveThreadId = binding?.active_thread_id ?? null;
  }

  return json({ ok: true, id: threadId, remoteEnabled: false, nextActiveThreadId });
}

async function handleThreadEvents(request: Request, env: Env, threadId: string) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return error(426, "WebSocket upgrade required.");
  }
  const token = authTokenFromRequestOrUrl(request);
  if (!token) {
    throw Object.assign(new Error("Unauthorized."), { status: 401 });
  }
  const ownerId = await ownerIdFromToken(token);
  assertAuthorized(await findThread(env, threadId), ownerId);
  if (!env.REMOTE_THREAD_SOCKET) {
    return error(500, "Remote thread socket Durable Object is not configured.");
  }

  const id = env.REMOTE_THREAD_SOCKET.idFromName(threadId);
  return env.REMOTE_THREAD_SOCKET.get(id).fetch(request);
}

export async function handleRequest(request: Request, env: Env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "remote-control" });
    }

    if (request.method === "POST" && url.pathname === "/webhooks/sendblue") {
      return await handleSendblueWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/installations") {
      return handleCreateInstallation();
    }

    if (parts[0] === "threads" && parts[1]) {
      const threadId = parts[1];
      if (request.method === "GET" && parts[2] === "events" && parts.length === 3) {
        return await handleThreadEvents(request, env, threadId);
      }
      if (request.method === "POST" && parts.length === 2) {
        return await handleRegister(request, env, threadId);
      }
      if (request.method === "POST" && parts[2] === "status" && parts.length === 3) {
        return await handleStatus(request, env, threadId);
      }
      if (request.method === "POST" && parts[2] === "stop" && parts.length === 3) {
        return await handleStopThread(request, env, threadId);
      }
      if (request.method === "GET" && parts[2] === "pending" && parts.length === 3) {
        return await handlePending(request, env, threadId);
      }
      if (
        request.method === "POST" &&
        parts[2] === "replies" &&
        parts[3] &&
        parts[4] === "claim" &&
        parts.length === 5
      ) {
        return await handleClaim(request, env, threadId, parts[3]);
      }
      if (request.method === "GET" && parts.length === 2) {
        return await handleGetThread(request, env, threadId);
      }
    }

    return error(404, "Not found.");
  } catch (caught) {
    const status = typeof (caught as { status?: unknown }).status === "number"
      ? (caught as { status: number }).status
      : 400;
    return error(status, caught instanceof Error ? caught.message : String(caught));
  }
}

export default {
  fetch: handleRequest,
};
