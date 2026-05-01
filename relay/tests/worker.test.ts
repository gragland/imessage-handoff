import assert from "node:assert/strict";
import test from "node:test";
import { HandoffSocket, handleRequest } from "../src/worker.ts";
import type { Env, PairingAttemptLimitRow, PhoneBindingRow, HandoffReplyRow, HandoffThreadRow } from "../src/types.ts";

// The relay tests run the Worker directly in Node. These fakes keep the tests
// fast while still exercising the same request handlers that Wrangler serves.
async function ownerIdForToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`imessage-handoff:${token}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DEV_OWNER_ID = await ownerIdForToken("dev-token");
const relayBuffers = new WeakMap<Env, HandoffSocket>();

function outboundContents(calls: Array<Record<string, unknown> | null>) {
  return calls
    .filter((call) => call && typeof call.content === "string")
    .map((call) => call?.content);
}

class FakeStatement {
  #db: FakeD1Database;
  #sql: string;
  #values: unknown[] = [];

  constructor(db: FakeD1Database, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }

  async run() {
    return this.#db.run(this.#sql, this.#values);
  }

  async first<T>() {
    return this.#db.first<T>(this.#sql, this.#values);
  }

  async all<T>() {
    return this.#db.all<T>(this.#sql, this.#values);
  }
}

class FakeD1Database {
  // This is a tiny in-memory stand-in for the specific D1 queries the Worker
  // issues. When a production query changes, this fake usually needs the same
  // behavior added so tests continue to mirror the deployed relay.
  threads = new Map<string, HandoffThreadRow>();
  phoneBindings = new Map<string, PhoneBindingRow>();
  pairingAttemptLimits = new Map<string, PairingAttemptLimitRow>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO handoff_threads")) {
      const [id, ownerId, cwd, title, handoffSummary, pairingCode, pairingCodeExpiresAt, createdAt, updatedAt] = values as string[];
      const existing = this.threads.get(id);
      this.threads.set(id, {
        id,
        owner_id: ownerId,
        cwd,
        title: title ?? null,
        handoff_summary: handoffSummary ?? null,
        status: "enabled",
        handoff_enabled: 1,
        pairing_code: pairingCode,
        pairing_code_expires_at: pairingCodeExpiresAt,
        last_stop_at: existing?.last_stop_at ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE phone_bindings") && sql.includes("WHERE owner_id = ?")) {
      const [nextThreadId, updatedAt, ownerId] = values as string[];
      for (const binding of this.phoneBindings.values()) {
        if (binding.owner_id === ownerId) {
          binding.active_thread_id = nextThreadId;
          binding.updated_at = updatedAt;
        }
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE phone_bindings") && sql.includes("contact_card_sent_at")) {
      const [sentAt, updatedAt, phoneNumber] = values as string[];
      const binding = this.phoneBindings.get(phoneNumber);
      if (binding) {
        binding.contact_card_sent_at = sentAt;
        binding.updated_at = updatedAt;
      }
      return { meta: { changes: binding ? 1 : 0 } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("pairing_code = NULL") && !sql.includes("handoff_enabled = 0")) {
      if (sql.includes("WHERE owner_id = ?")) {
        const [updatedAt, ownerId, excludedId] = values as string[];
        for (const thread of this.threads.values()) {
          if (thread.owner_id === ownerId && thread.id !== excludedId) {
            thread.pairing_code = null;
            thread.pairing_code_expires_at = null;
            thread.updated_at = updatedAt;
          }
        }
        return { meta: { changes: 1 } };
      }
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.pairing_code = null;
      thread.pairing_code_expires_at = null;
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE handoff_threads") && sql.includes("handoff_enabled = 0")) {
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.status = "stopped";
      thread.handoff_enabled = 0;
      thread.pairing_code = null;
      thread.pairing_code_expires_at = null;
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE handoff_threads SET updated_at = ? WHERE id = ?")) {
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE handoff_threads")) {
      const [cwd, status, lastStopAt, updatedAt, id] = values as Array<string | null>;
      const thread = this.threads.get(String(id));
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.cwd = String(cwd);
      thread.status = String(status);
      thread.last_stop_at = String(lastStopAt);
      thread.updated_at = String(updatedAt);
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO pairing_attempt_limits")) {
      const [phoneNumber, failedCount, windowStartAt, blockedUntil, updatedAt] = values as Array<string | number | null>;
      const normalizedPhone = String(phoneNumber);
      this.pairingAttemptLimits.set(normalizedPhone, {
        phone_number: normalizedPhone,
        failed_count: Number(failedCount),
        window_start_at: String(windowStartAt),
        blocked_until: blockedUntil ? String(blockedUntil) : null,
        updated_at: String(updatedAt),
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("DELETE FROM pairing_attempt_limits")) {
      const deleted = this.pairingAttemptLimits.delete(String(values[0]));
      return { meta: { changes: deleted ? 1 : 0 } };
    }

    if (sql.includes("DELETE FROM phone_bindings")) {
      const [ownerId, phoneNumber] = values as string[];
      for (const [key, binding] of this.phoneBindings.entries()) {
        if (binding.owner_id === ownerId && binding.phone_number !== phoneNumber) {
          this.phoneBindings.delete(key);
        }
      }
      return { meta: { changes: 1 } };
    }

    if (sql.includes("INSERT INTO phone_bindings")) {
      const [phoneNumber, ownerId, activeThreadId, createdAt, updatedAt] = values as string[];
      const existing = this.phoneBindings.get(phoneNumber);
      for (const [key, binding] of this.phoneBindings.entries()) {
        if (binding.owner_id === ownerId && binding.phone_number !== phoneNumber) {
          this.phoneBindings.delete(key);
        }
      }
      this.phoneBindings.set(phoneNumber, {
        phone_number: phoneNumber,
        owner_id: ownerId,
        active_thread_id: activeThreadId,
        contact_card_sent_at: existing?.contact_card_sent_at ?? null,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected run SQL: ${sql}`);
  }

  first<T>(sql: string, values: unknown[]) {
    if (sql.includes("FROM phone_bindings WHERE phone_number = ?")) {
      return (this.phoneBindings.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("FROM phone_bindings WHERE owner_id = ?")) {
      const ownerId = String(values[0]);
      return ([...this.phoneBindings.values()].find((binding) => binding.owner_id === ownerId) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM handoff_threads WHERE pairing_code = ?")) {
      const pairingCode = String(values[0]);
      const now = String(values[1] ?? "");
      return ([...this.threads.values()].find((thread) =>
        thread.pairing_code === pairingCode
        && thread.handoff_enabled === 1
        && Boolean(thread.pairing_code_expires_at)
        && String(thread.pairing_code_expires_at) > now
      ) ?? null) as T | null;
    }

    if (sql.includes("FROM pairing_attempt_limits WHERE phone_number = ?")) {
      return (this.pairingAttemptLimits.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM handoff_threads")) {
      return (this.threads.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("FROM phone_bindings WHERE active_thread_id = ?")) {
      const threadId = String(values[0]);
      return ([...this.phoneBindings.values()].find((binding) => binding.active_thread_id === threadId) ?? null) as T | null;
    }

    throw new Error(`Unexpected first SQL: ${sql}`);
  }

  all<T>(sql: string, values: unknown[]) {
    if (sql.includes("FROM handoff_threads") && sql.includes("handoff_enabled = 1")) {
      const ownerId = String(values[0]);
      const results = [...this.threads.values()]
        .filter((thread) => thread.owner_id === ownerId && thread.handoff_enabled === 1)
        .sort((a, b) => (
          b.updated_at.localeCompare(a.updated_at)
          || b.created_at.localeCompare(a.created_at)
          || b.id.localeCompare(a.id)
        )) as T[];
      return { results };
    }

    throw new Error(`Unexpected all SQL: ${sql}`);
  }
}

function env() {
  const testEnv = {
    DB: new FakeD1Database() as unknown as D1Database,
    SENDBLUE_API_KEY: "sendblue-key",
    SENDBLUE_SECRET_KEY: "sendblue-secret",
    SENDBLUE_WEBHOOK_SECRET: "webhook-secret",
    SENDBLUE_FROM_NUMBER: "+12344198201",
    SENDBLUE_API_BASE_URL: "https://api.sendblue.test/api",
    SENDBLUE_TYPING_DELAY_MS: "0",
  } satisfies Env;
  attachRelayBuffer(testEnv);
  return testEnv;
}

function attachRelayBuffer(testEnv: Env) {
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets() {
      return [];
    },
  } as unknown as DurableObjectState);
  testEnv.HANDOFF_SOCKET = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        id,
        fetch: (request: Request) => relay.fetch(request),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  relayBuffers.set(testEnv, relay);
  return relay;
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://imessage-handoff.test${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function relayReplies(testEnv: Env) {
  const relay = relayBuffers.get(testEnv);
  assert.ok(relay, "test env has a relay buffer");
  return [...(relay as unknown as { replies: Map<string, HandoffReplyRow> }).replies.values()];
}

function pendingReplies(testEnv: Env, threadId?: string) {
  return relayReplies(testEnv).filter((reply) => reply.status === "pending" && (!threadId || reply.thread_id === threadId));
}

async function notification(response: Response) {
  return (await json(response)).notification as Record<string, unknown>;
}

async function register(testEnv: Env, overrides: Record<string, unknown> = {}) {
  const threadId = "thread-test-1";
  const response = await handleRequest(req(`/threads/${threadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "iMessage test", ...overrides }),
  }), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.id, threadId);
  return threadId;
}

function sendblueWebhook(body: Record<string, unknown>, secret = "webhook-secret") {
  return req("/webhooks/sendblue", {
    method: "POST",
    headers: { "sb-signing-secret": secret },
    body: JSON.stringify(body),
  });
}

function inboundMessage(content: string, handle = "msg_1", fromNumber = "+15551234567") {
  return {
    content,
    is_outbound: false,
    status: "RECEIVED",
    message_handle: handle,
    from_number: fromNumber,
    number: fromNumber,
  };
}

function inboundImage(content: string, mediaUrl: string, handle = "msg_img_1", fromNumber = "+15551234567") {
  return {
    ...inboundMessage(content, handle, fromNumber),
    media_url: mediaUrl,
  };
}

function generatedImage(filename: string, data = "png-bytes") {
  return {
    filename,
    mimeType: "image/png",
    dataBase64: Buffer.from(data).toString("base64"),
  };
}

function generatedImageBytes(filename: string, bytes: Uint8Array) {
  return {
    filename,
    mimeType: "image/png",
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

test("creates install tokens", async () => {
  const testEnv = env();
  const response = await handleRequest(req("/installations", { method: "POST" }), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(typeof body.token, "string");
  assert.match(String(body.token), /^ih_[a-f0-9]{64}$/);
});

test("rate limits installation token creation by client IP", async () => {
  const testEnv = env();
  for (let index = 0; index < 30; index += 1) {
    const response = await handleRequest(req("/installations", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }), testEnv);
    assert.equal(response.status, 200);
  }

  const limited = await handleRequest(req("/installations", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.10" },
  }), testEnv);
  assert.equal(limited.status, 429);
});

test("serves the Codex contact card and image", async () => {
  const testEnv = env();
  const card = await handleRequest(req("/contact.vcf"), testEnv);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "text/vcard; charset=utf-8");
  const body = await card.text();
  assert.match(body, /FN:Codex/);
  assert.match(body, /N:Codex;;;;/);
  assert.match(body, /TEL;TYPE=CELL:\+12344198201/);
  assert.match(body, /PHOTO;ENCODING=b;TYPE=JPEG:/);
  assert.match(body, /\r\n [A-Za-z0-9+/=]+/);
  assert.doesNotMatch(body, /^ORG:/m);
  assert.doesNotMatch(body, /^URL:/m);
  assert.doesNotMatch(body, /^NOTE:/m);

  const image = await handleRequest(req("/codex-contact.jpg"), testEnv);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.ok((await image.arrayBuffer()).byteLength > 1000);
});

test("creates and upserts a handoff thread with an explicit id", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const upsert = await handleRequest(req(`/threads/${threadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project-renamed",
      title: "iMessage test updated",
      handoffSummary: "You were reviewing iMessage handoff copy.",
    }),
  }), testEnv);
  assert.equal(upsert.status, 200);
  const upsertBody = await json(upsert);
  assert.equal(upsertBody.pairingRequired, true);
  assert.equal(upsertBody.paired, false);

  const response = await handleRequest(req(`/threads/${threadId}`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(response);
  assert.equal(body.id, threadId);
  assert.equal(typeof body.pairingCode, "string");
  assert.equal(String(body.pairingCode).length, 6);
  assert.equal(typeof body.pairingCodeExpiresAt, "string");
  assert.equal(Date.parse(String(body.pairingCodeExpiresAt)) > Date.now(), true);
  assert.equal(body.cwd, "/tmp/project-renamed");
  assert.equal(body.title, "iMessage test updated");
  assert.equal(body.handoffSummary, "You were reviewing iMessage handoff copy.");
  assert.equal(body.status, "enabled");
  assert.equal(body.handoffEnabled, true);
});

test("limits enabled handoff threads per owner", async () => {
  const testEnv = env();
  for (let index = 1; index <= 25; index += 1) {
    const response = await handleRequest(req(`/threads/thread-limit-${index}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/project", title: `Thread ${index}` }),
    }), testEnv);
    assert.equal(response.status, 200);
  }

  const limited = await handleRequest(req("/threads/thread-limit-26", {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "Thread 26" }),
  }), testEnv);
  assert.equal(limited.status, 429);
  assert.match(String((await json(limited)).error), /Too many active handoff threads/);
});

test("proxies authorized thread websocket upgrades to the Durable Object", async () => {
  const testEnv: Env = env();
  const threadId = await register(testEnv);
  const calls: Array<{ name: string; url: string }> = [];
  testEnv.HANDOFF_SOCKET = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        id,
        fetch: async (request: Request) => {
          calls.push({ name: (id as unknown as { name: string }).name, url: request.url });
          if (new URL(request.url).pathname === "/rate-limit") {
            return new Response(JSON.stringify({ ok: true, allowed: true }), { status: 200 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  const response = await handleRequest(req(`/threads/${threadId}/events?token=dev-token`, {
    headers: { upgrade: "websocket" },
  }), testEnv);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    {
      name: "global",
      url: "https://imessage-handoff.internal/rate-limit",
    },
    {
      name: "global",
      url: "https://imessage-handoff.internal/rate-limit",
    },
    {
      name: "global",
      url: `https://imessage-handoff.test/threads/${threadId}/events?token=dev-token`,
    },
  ]);
});

test("rejects unauthorized thread websocket upgrades", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);

  const response = await handleRequest(req(`/threads/${threadId}/events?token=wrong-token`, {
    headers: { upgrade: "websocket" },
  }), testEnv);

  assert.equal(response.status, 401);
});

test("relay buffer notifies connected thread websockets when replies arrive", async () => {
  const sent: string[] = [];
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      assert.equal(tag, "thread-test-1");
      return [{
        send(message: string) {
          sent.push(message);
        },
      }];
    },
  } as unknown as DurableObjectState);

  const response = await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-1/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "hello", externalId: "msg_notify", status: "pending" }),
  }));

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  const message = JSON.parse(sent[0] ?? "{}");
  assert.equal(message.type, "reply-pending");
  assert.equal(message.threadId, "thread-test-1");
  assert.match(message.replyId, /^reply_/);
});

test("relay buffer sends queued replies to a socket on connect", async () => {
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets() {
      return [];
    },
  } as unknown as DurableObjectState);

  await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-1/replies", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "queued", externalId: "msg_queued", status: "pending" }),
  }));

  const sent: string[] = [];
  (relay as unknown as {
    notifySocketOrScheduleNextPending(threadId: string, socket: { send(message: string): void }): void;
  }).notifySocketOrScheduleNextPending("thread-test-1", {
    send(message: string) {
      sent.push(message);
    },
  });

  assert.equal(sent.length, 1);
  const message = JSON.parse(sent[0] ?? "{}");
  assert.equal(message.type, "reply-pending");
  assert.equal(message.threadId, "thread-test-1");
  assert.match(message.replyId, /^reply_/);
});

test("relay buffer waits for media group quiet window before websocket notification", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const timers: Array<() => void> = [];
  globalThis.setTimeout = ((callback: TimerHandler) => {
    timers.push(callback as () => void);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const sent: string[] = [];
  const relay = new HandoffSocket({
    acceptWebSocket() {},
    getWebSockets(tag?: string) {
      assert.equal(tag, "thread-test-1");
      return [{
        send(message: string) {
          sent.push(message);
        },
      }];
    },
  } as unknown as DurableObjectState);

  try {
    await relay.fetch(new Request("https://imessage-handoff.internal/threads/thread-test-1/replies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "inspect",
        externalId: "media_group_1",
        status: "pending",
        mediaUrl: "https://cdn.sendblue.test/one.png",
      }),
    }));

    assert.equal(sent.length, 0);
    assert.equal(timers.length, 1);
    for (const reply of (relay as unknown as { replies: Map<string, HandoffReplyRow> }).replies.values()) {
      reply.created_at = "2026-04-25T18:20:00.000Z";
    }
    timers[0]?.();

    assert.equal(sent.length, 1);
    const message = JSON.parse(sent[0] ?? "{}");
    assert.equal(message.type, "reply-pending");
    assert.equal(message.threadId, "thread-test-1");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("pairs a phone by code without enqueueing a pending reply", async () => {
  const testEnv = env();
  const threadId = await register(testEnv, {
    handoffSummary: "You were deciding what the first playable prototype should include.",
  });
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init?.headers),
    });
    if (String(input).includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_1")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.paired, true);
    assert.equal(body.service, "iMessage");
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);
    assert.equal(db.threads.get(threadId)?.pairing_code, null);
    assert.equal(db.threads.get(threadId)?.pairing_code_expires_at, null);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [{
      number: "+15551234567",
      from_number: "+12344198201",
    }, null, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Add me as a contact so you remember who I am.",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_url: "https://imessage-handoff.test/contact.vcf",
    }, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: 'You’re connected to "iMessage test" on Codex.\n\nYou were deciding what the first playable prototype should include.\n\nWhat do you want to do next?',
    }]);
    assert.equal(typeof db.phoneBindings.get("+15551234567")?.contact_card_sent_at, "string");

    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends the pairing contact card only once per phone", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: "previous-owner",
    active_thread_id: null,
    contact_card_sent_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_seen_contact")), testEnv);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(outboundContents(calls), [
    'You’re connected to "iMessage test" on Codex.\n\nWhat do you want to do next?',
  ]);
  assert.equal(db.phoneBindings.get("+15551234567")?.owner_id, DEV_OWNER_ID);
  assert.equal(db.phoneBindings.get("+15551234567")?.contact_card_sent_at, "2026-01-01T00:00:00.000Z");
});

test("activation message omits the summary paragraph when no summary exists", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_no_summary")), testEnv);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(outboundContents(calls), [
    "Add me as a contact so you remember who I am.",
    'You’re connected to "iMessage test" on Codex.\n\nWhat do you want to do next?',
  ]);
});

test("activation message uses generic copy when no title exists", async () => {
  const testEnv = env();
  const threadId = await register(testEnv, { title: "" });
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_no_title")), testEnv);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(outboundContents(calls), [
    "Add me as a contact so you remember who I am.",
    "You’re connected to this Codex thread.\n\nWhat do you want to do next?",
  ]);
});

test("pairing rejects phone numbers that do not support iMessage", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (String(input).includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "SMS" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "pair_msg_sms")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.paired, false);
    assert.equal(body.unsupportedService, "SMS");
    assert.equal(db.phoneBindings.get("+15551234567"), undefined);
    assert.equal(db.threads.get(threadId)?.pairing_code, pairingCode);
    assert.equal(typeof db.threads.get(threadId)?.pairing_code_expires_at, "string");
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [{
      number: "+15551234567",
      from_number: "+12344198201",
    }, null, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "iMessage Handoff only supports phone numbers that use iMessage for now.",
    }]);
    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("subsequent inbound texts from a paired phone enqueue for the active thread", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundMessage("What is 2 + 2?", "msg_2")), testEnv);
  assert.equal(response.status, 200);
  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, "What is 2 + 2?");
});

test("relay buffer keeps inbound message content out of D1", async () => {
  const testEnv = env();
  attachRelayBuffer(testEnv);
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundMessage("What is buffered?", "msg_buffered")), testEnv);
  assert.equal(response.status, 200);
  // The fake D1 no longer implements message-content tables, so this request
  // would throw if the Worker tried to persist the inbound body there.

  const body = await json(response) as { replyId?: string };
  const replyId = body.replyId;
  assert.equal(typeof replyId, "string");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "SENT", message_handle: "typing-1" }), { status: 200 });
  try {
    const claim = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(claim.status, 200);
    const claimBody = await json(claim) as { reply: { body: string } };
    assert.equal(claimBody.reply.body, "What is buffered?");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const duplicate = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  assert.equal(duplicate.status, 409);
});

test("image-only sendblue webhook creates a pending media reply after quiet window", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundImage("", "https://cdn.example.test/cow.jpg", "img_1")), testEnv);
  assert.equal(response.status, 200);
  const reply = pendingReplies(testEnv, threadId)[0];
  assert.equal(reply?.body, "");
  assert.deepEqual(JSON.parse(String(reply?.media)), [{ url: "https://cdn.example.test/cow.jpg" }]);
  assert.equal(reply?.media_group_id, "img");
  assert.equal(reply?.media_index, 1);
  if (reply) {
    reply.created_at = "2026-04-25T18:30:00.000Z";
  }

  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, "");
  assert.deepEqual(JSON.parse(String(replies[0]?.media)), [{ url: "https://cdn.example.test/cow.jpg" }]);
});

test("text plus image webhook stores both body and media", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  await handleRequest(sendblueWebhook(inboundImage("What is this?", "https://cdn.example.test/photo.png", "img_2")), testEnv);
  const reply = pendingReplies(testEnv, threadId)[0];
  assert.equal(reply?.body, "What is this?");
  assert.deepEqual(JSON.parse(String(reply?.media)), [{ url: "https://cdn.example.test/photo.png" }]);
});

test("multi-image sendblue webhooks claim as one grouped reply after quiet window", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundImage("Compare these", "https://cdn.example.test/one.png", "group_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundImage("", "https://cdn.example.test/two.png", "group_2")), testEnv);

  assert.equal(pendingReplies(testEnv, threadId).length, 2);

  for (const reply of pendingReplies(testEnv, threadId)) {
    reply.created_at = reply.media_index === 1 ? "2026-04-25T18:30:00.000Z" : "2026-04-25T18:30:01.000Z";
  }

  const firstReplyId = pendingReplies(testEnv, threadId).find((reply) => reply.media_index === 1)?.id;
  assert.equal(typeof firstReplyId, "string");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  try {
    const claim = await handleRequest(req(`/threads/${threadId}/replies/${firstReplyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(claim.status, 200);
    const claimBody = await json(claim) as { reply: { body: string; media: Array<{ url: string }> } };
    assert.equal(claimBody.reply.body, "Compare these");
    assert.deepEqual(claimBody.reply.media, [
      { url: "https://cdn.example.test/one.png" },
      { url: "https://cdn.example.test/two.png" },
    ]);
    const tombstones = relayReplies(testEnv).filter((reply) => reply.media_group_id === "group");
    assert.deepEqual(tombstones.map((reply) => ({ status: reply.status, body: reply.body, media: reply.media })), [
      { status: "applied", body: "", media: null },
      { status: "applied", body: "", media: null },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list and numeric switching remain text-only when media is attached", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  await handleRequest(sendblueWebhook(inboundImage("list", "https://cdn.example.test/list.png", "media_list")), testEnv);
  await handleRequest(sendblueWebhook(inboundImage("1", "https://cdn.example.test/one.png", "media_number")), testEnv);

  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((reply) => reply.body), ["list", "1"]);
});

test("starting another thread for a paired user makes it active", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const secondThreadId = "thread-test-2";
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  let secondBody: Record<string, unknown> = {};
  try {
    const startSecond = await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        title: "Second",
        handoffSummary: "You were choosing the next iMessage task.",
      }),
    }), testEnv);
    assert.equal(startSecond.status, 200);
    secondBody = await json(startSecond);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(secondBody.pairingRequired, false);
  assert.equal(secondBody.paired, true);
  assert.equal(secondBody.pairingCode, null);
  assert.equal(secondBody.skipNextStatusSend, true);
  assert.deepEqual(outboundContents(calls), ['You’re connected to "Second" on Codex.\n\nYou were choosing the next iMessage task.\n\nWhat do you want to do next?']);
  assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, secondThreadId);
  assert.equal(db.threads.get(secondThreadId)?.pairing_code, null);

  await handleRequest(sendblueWebhook(inboundMessage("Use the new one", "msg_2")), testEnv);
  assert.equal(pendingReplies(testEnv, firstThreadId).length, 0);
  assert.equal(pendingReplies(testEnv, secondThreadId).length, 1);
});

test("list command returns numbered enabled threads without status labels", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const secondThreadId = "thread-test-2";
    await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/second", title: "Second" }),
    }), testEnv);
    calls.length = 0;
    db.threads.get(firstThreadId)!.updated_at = "2026-04-25T18:20:00.000Z";
    db.threads.get(secondThreadId)!.updated_at = "2026-04-25T18:21:00.000Z";

    const response = await handleRequest(sendblueWebhook(inboundMessage("list", "list_msg_1")), testEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(outboundContents(calls), [
      "iMessage Handoff threads:\n\n1. Second (current)\n2. iMessage test\n\nReply with a number to switch.",
    ]);
    assert.doesNotMatch(String(calls[0]?.content), /enabled|stopped/i);
    const pending = pendingReplies(testEnv);
    assert.deepEqual(pending, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list command reports when the paired phone has no iMessage handoff threads", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  db.threads.get(threadId)!.handoff_enabled = 0;
  db.phoneBindings.get("+15551234567")!.active_thread_id = null;

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage("list", "list_msg_empty")), testEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(outboundContents(calls), ["You have no iMessage handoff threads"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal text reports when there is no active thread to forward to", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  db.threads.get(threadId)!.handoff_enabled = 0;
  db.phoneBindings.get("+15551234567")!.active_thread_id = null;

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage("What is 2 + 2?", "msg_no_thread")), testEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(outboundContents(calls), ["You have no iMessage handoff threads"]);
    const pending = pendingReplies(testEnv);
    assert.deepEqual(pending, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("number command switches the active thread using the current list order", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const secondThreadId = "thread-test-2";
    await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/second", title: "Second" }),
    }), testEnv);
    calls.length = 0;
    db.threads.get(firstThreadId)!.updated_at = "2026-04-25T18:20:00.000Z";
    db.threads.get(secondThreadId)!.updated_at = "2026-04-25T18:21:00.000Z";

    const response = await handleRequest(sendblueWebhook(inboundMessage("2", "switch_msg_1")), testEnv);
    assert.equal(response.status, 200);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, firstThreadId);
    assert.deepEqual(outboundContents(calls), ['Switched to "iMessage test".']);

    await handleRequest(sendblueWebhook(inboundMessage("Now use the first thread", "msg_2")), testEnv);
    assert.equal(pendingReplies(testEnv, firstThreadId).length, 1);
    assert.equal(pendingReplies(testEnv, secondThreadId).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("out-of-range number command does not change the active thread or enqueue a reply", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage("2", "switch_msg_bad")), testEnv);
    assert.equal(response.status, 200);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, threadId);
    assert.deepEqual(outboundContents(calls), ["Text threads to see active iMessage handoff threads."]);
    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stopping a thread disables it and switches to the newest remaining thread", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(firstThreadId)?.pairing_code), "pair_msg_1")), testEnv);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const secondThreadId = "thread-test-2";
    await handleRequest(req(`/threads/${secondThreadId}`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({ cwd: "/tmp/second", title: "Second" }),
    }), testEnv);
    calls.length = 0;
    db.threads.get(firstThreadId)!.updated_at = "2026-04-25T18:20:00.000Z";
    db.threads.get(secondThreadId)!.updated_at = "2026-04-25T18:21:00.000Z";
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, secondThreadId);

    const stop = await handleRequest(req(`/threads/${secondThreadId}/stop`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(stop.status, 200);
    assert.equal((await json(stop)).nextActiveThreadId, firstThreadId);
    assert.equal(db.threads.get(secondThreadId)?.handoff_enabled, 0);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, firstThreadId);

    await handleRequest(sendblueWebhook(inboundMessage("list", "list_after_stop")), testEnv);
    assert.deepEqual(outboundContents(calls), [
      "iMessage Handoff threads:\n\n1. iMessage test (current)\n\nReply with a number to switch.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("starting another thread for an unpaired user replaces the old pairing code", async () => {
  const testEnv = env();
  const firstThreadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const firstCode = db.threads.get(firstThreadId)?.pairing_code;
  assert.equal(typeof firstCode, "string");

  const secondThreadId = "thread-test-2";
  const startSecond = await handleRequest(req(`/threads/${secondThreadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "Second" }),
  }), testEnv);
  assert.equal(startSecond.status, 200);
  assert.equal(db.threads.get(firstThreadId)?.pairing_code, null);
  assert.equal(db.threads.get(firstThreadId)?.pairing_code_expires_at, null);

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const oldCodeResponse = await handleRequest(sendblueWebhook(inboundMessage(String(firstCode), "old_pair_msg")), testEnv);
    assert.equal(oldCodeResponse.status, 200);
    const oldCodeBody = await json(oldCodeResponse);
    assert.equal(oldCodeBody.invalidPairingCode, true);
    assert.deepEqual(outboundContents(calls), [
      "That pairing code is invalid or expired. Start iMessage Handoff again in Codex to get a fresh code.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unknown senders are acknowledged without enqueueing", async () => {
  const testEnv = env();
  const response = await handleRequest(sendblueWebhook(inboundMessage("hello", "msg_unknown")), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ignored, true);
});

test("expired pairing codes do not pair and send an invalid code message", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = db.threads.get(threadId)?.pairing_code;
  assert.equal(typeof pairingCode, "string");
  db.threads.get(threadId)!.pairing_code_expires_at = "2026-01-01T00:00:00.000Z";

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(String(pairingCode), "expired_pair_msg")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.paired, false);
    assert.equal(body.invalidPairingCode, true);
    assert.equal(db.phoneBindings.get("+15551234567"), undefined);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(outboundContents(calls.map((call) => call.body)), [
      "That pairing code is invalid or expired. Start iMessage Handoff again in Codex to get a fresh code.",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed pairing attempts are rate limited per phone number", async () => {
  const testEnv = env();
  await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown> | null> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const badCodes = ["BADA2A", "BADA3A", "BADA4A", "BADA5A", "BADA6A", "BADA7A"];
    for (let index = 0; index < 5; index += 1) {
      const response = await handleRequest(sendblueWebhook(inboundMessage(String(badCodes[index]), `bad_pair_${index}`)), testEnv);
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.invalidPairingCode, true);
      assert.equal(body.rateLimited, false);
    }

    const limited = await handleRequest(sendblueWebhook(inboundMessage(String(badCodes[5]), "bad_pair_6")), testEnv);
    assert.equal(limited.status, 200);
    const body = await json(limited);
    assert.equal(body.paired, false);
    assert.equal(body.rateLimited, true);
    assert.equal(typeof body.retryAfterSeconds, "number");
    assert.equal(Number(body.retryAfterSeconds) > 0, true);
    assert.equal(db.pairingAttemptLimits.get("+15551234567")?.failed_count, 6);
    assert.match(String(outboundContents(calls).at(-1)), /Too many pairing attempts\. Try again in about 30 minutes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("blocked phones cannot pair even with a valid code until the block expires", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = String(db.threads.get(threadId)?.pairing_code);
  db.pairingAttemptLimits.set("+15551234567", {
    phone_number: "+15551234567",
    failed_count: 6,
    window_start_at: new Date().toISOString(),
    blocked_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(pairingCode, "blocked_valid_pair")), testEnv);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.rateLimited, true);
    assert.equal(db.phoneBindings.get("+15551234567"), undefined);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/mark-read",
      "https://api.sendblue.test/api/send-message",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful pairing clears prior failed attempts", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  const pairingCode = String(db.threads.get(threadId)?.pairing_code);
  db.pairingAttemptLimits.set("+15551234567", {
    phone_number: "+15551234567",
    failed_count: 3,
    window_start_at: new Date().toISOString(),
    blocked_until: null,
    updated_at: new Date().toISOString(),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/evaluate-service")) {
      return new Response(JSON.stringify({ number: "+15551234567", service: "iMessage" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const response = await handleRequest(sendblueWebhook(inboundMessage(pairingCode, "valid_after_failures")), testEnv);
    assert.equal(response.status, 200);
    assert.equal((await json(response)).paired, true);
    assert.equal(db.pairingAttemptLimits.get("+15551234567"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate sendblue message handles are ignored", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("once", "msg_2")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("twice", "msg_2")), testEnv);

  assert.deepEqual(pendingReplies(testEnv, threadId).map((reply) => reply.body), ["once"]);
});

test("bad sendblue webhook secret is rejected", async () => {
  const testEnv = env();
  const response = await handleRequest(sendblueWebhook(inboundMessage("hello"), "wrong-secret"), testEnv);
  assert.equal(response.status, 401);
});

test("missing sendblue webhook secret is rejected as misconfigured", async () => {
  const testEnv: Env = {
    ...env(),
    SENDBLUE_WEBHOOK_SECRET: undefined,
  };

  const response = await handleRequest(sendblueWebhook(inboundMessage("hello")), testEnv);
  assert.equal(response.status, 500);
  assert.match(String((await json(response)).error), /webhook secret/i);
});

test("sendblue webhook ignores outbound non-received and empty events", async () => {
  const testEnv = env();
  const outbound = await handleRequest(sendblueWebhook({ ...inboundMessage("hello"), is_outbound: true }), testEnv);
  const pending = await handleRequest(sendblueWebhook({ ...inboundMessage("hello"), status: "PENDING", message_handle: "msg_pending" }), testEnv);
  const empty = await handleRequest(sendblueWebhook(inboundMessage("   ", "msg_empty")), testEnv);
  assert.equal(outbound.status, 200);
  assert.equal(pending.status, 200);
  assert.equal(empty.status, 200);
});

test("enqueues replies from paired Sendblue texts", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("Append a line", "msg_2")), testEnv);

  const replies = pendingReplies(testEnv, threadId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.body, "Append a line");
});

test("claims a pending reply exactly once", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("Do it once", "msg_2")), testEnv);
  const replyId = pendingReplies(testEnv, threadId)[0]?.id;
  assert.equal(typeof replyId, "string");

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ status: "SENT" }), { status: 200 });
  };
  try {
    const claim = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(claim.status, 200);
    assert.equal((await json(claim)).ok, true);
    assert.deepEqual(calls, [{
      url: "https://api.sendblue.test/api/send-typing-indicator",
      body: {
        number: "+15551234567",
        from_number: "+12344198201",
      },
    }]);

    const duplicate = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(duplicate.status, 409);

    assert.deepEqual(pendingReplies(testEnv, threadId), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publishes status and shows debug thread state", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const status = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      lastAssistantMessage: "Done.",
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(status.status, 200);

  const debug = await handleRequest(req(`/threads/${threadId}`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(debug);
  assert.equal(body.id, threadId);
  assert.equal(body.lastAssistantMessage, undefined);
  assert.equal(body.lastStopAt, "2026-04-25T18:25:00.000Z");
});

test("publishes every non-empty status to sendblue", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    const requestBody = {
      cwd: "/tmp/project",
      lastAssistantMessage: "Created [TEMP](/Owners/gabe/project/TEMP).",
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    };
    const first = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify(requestBody),
    }), testEnv);
    const duplicate = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify(requestBody),
    }), testEnv);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://api.sendblue.test/api/send-message");
    assert.equal(calls[0]?.headers.get("sb-api-key-id"), "sendblue-key");
    assert.equal(calls[0]?.headers.get("sb-api-secret-key"), "sendblue-secret");
    assert.deepEqual(calls[0]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Created TEMP.",
    });
    assert.equal((await notification(duplicate)).messageHandle, "message-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publishes each changed assistant message", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: `message-${calls.length}` }), { status: 200 });
  };
  try {
    for (const lastAssistantMessage of ["81", "Created [TEMP](/tmp/TEMP)."]) {
      const response = await handleRequest(req(`/threads/${threadId}/status`, {
        method: "POST",
        headers: { authorization: "Bearer dev-token" },
        body: JSON.stringify({
          cwd: "/tmp/project",
          lastAssistantMessage,
          status: "stopped",
          createdAt: "2026-04-25T18:25:00.000Z",
        }),
      }), testEnv);
      assert.equal(response.status, 200);
    }

    assert.deepEqual(outboundContents(calls), ["81", "Created TEMP."]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads one generated image and sends it with send-message", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : JSON.parse(String(init?.body)),
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: "https://cdn.sendblue.test/cow.png" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: null,
        generatedImages: [generatedImage("cow.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls, [
      { url: "https://api.sendblue.test/api/upload-file", body: "form-data" },
      {
        url: "https://api.sendblue.test/api/send-message",
        body: {
          number: "+15551234567",
          from_number: "+12344198201",
          media_url: "https://cdn.sendblue.test/cow.png",
        },
      },
    ]);
    assert.equal((await notification(status)).messageHandle, "message-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects status messages that exceed the text cap", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      lastAssistantMessage: "x".repeat(20_001),
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(response.status, 413);
});

test("rejects more than five generated images", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      generatedImages: [
        generatedImage("1.png"),
        generatedImage("2.png"),
        generatedImage("3.png"),
        generatedImage("4.png"),
        generatedImage("5.png"),
        generatedImage("6.png"),
      ],
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(response.status, 413);
});

test("rejects generated images larger than ten megabytes", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}/status`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project",
      generatedImages: [generatedImageBytes("too-big.png", new Uint8Array((10 * 1024 * 1024) + 1))],
      status: "stopped",
      createdAt: "2026-04-25T18:25:00.000Z",
    }),
  }), testEnv);
  assert.equal(response.status, 413);
});

test("sends text and one generated image together", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : JSON.parse(String(init?.body)),
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: "https://cdn.sendblue.test/cow.png" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "message-1" }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Here is **a cow**.",
        generatedImages: [generatedImage("cow.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls[1], {
      url: "https://api.sendblue.test/api/send-message",
      body: {
        number: "+15551234567",
        from_number: "+12344198201",
        content: "Here is a cow.",
        media_url: "https://cdn.sendblue.test/cow.png",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads multiple generated images and sends one carousel", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : JSON.parse(String(init?.body)),
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: `https://cdn.sendblue.test/image-${calls.length}.png` }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: "carousel-1" }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: null,
        generatedImages: [generatedImage("first.png"), generatedImage("second.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/send-carousel",
    ]);
    assert.deepEqual(calls[2]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      media_urls: [
        "https://cdn.sendblue.test/image-1.png",
        "https://cdn.sendblue.test/image-2.png",
      ],
    });
    assert.equal((await notification(status)).messageHandle, "carousel-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends text before carousel for text plus multiple images", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body instanceof FormData ? "form-data" : JSON.parse(String(init?.body)),
    });
    if (url.endsWith("/upload-file")) {
      return new Response(JSON.stringify({ media_url: `https://cdn.sendblue.test/image-${calls.length}.png` }), { status: 200 });
    }
    const handle = url.endsWith("/send-carousel") ? "carousel-1" : "message-1";
    return new Response(JSON.stringify({ status: "QUEUED", message_handle: handle }), { status: 200 });
  };
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Two cow options.",
        generatedImages: [generatedImage("first.png"), generatedImage("second.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/upload-file",
      "https://api.sendblue.test/api/send-message",
      "https://api.sendblue.test/api/send-carousel",
    ]);
    assert.deepEqual(calls[2]?.body, {
      number: "+15551234567",
      from_number: "+12344198201",
      content: "Two cow options.",
    });
    assert.equal((await notification(status)).messageHandle, "carousel-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue media failure does not fail status publish", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: "ERROR", message: "Upload failed" }), { status: 500 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: null,
        generatedImages: [generatedImage("cow.png")],
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.match(String((await notification(status)).error), /Sendblue media API returned HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue failure does not fail status publish", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Done.",
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.equal((await notification(status)).status, "ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue error body is redacted without failing status publish", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      status: "ERROR",
      error_code: 10001,
      error_message: "Message failed to send: Done.",
    }), { status: 200 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Done.",
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    const result = await notification(status);
    assert.equal(result.status, "ERROR");
    assert.equal(result.error, "Sendblue rejected message with status ERROR.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendblue response without a message handle returns notification error", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
    contact_card_sent_at: null,
    created_at: "2026-04-25T18:20:00.000Z",
    updated_at: "2026-04-25T18:20:00.000Z",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "OK" }), { status: 200 });
  try {
    const status = await handleRequest(req(`/threads/${threadId}/status`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
      body: JSON.stringify({
        cwd: "/tmp/project",
        lastAssistantMessage: "Done.",
        status: "stopped",
        createdAt: "2026-04-25T18:25:00.000Z",
      }),
    }), testEnv);
    assert.equal(status.status, 200);
    assert.equal((await notification(status)).status, "ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects requests with the wrong thread token", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const response = await handleRequest(req(`/threads/${threadId}`, {
    headers: { authorization: "Bearer wrong-token" },
  }), testEnv);
  assert.equal(response.status, 401);
});
