import assert from "node:assert/strict";
import test from "node:test";
import { RemoteThreadSocket, handleRequest } from "../src/worker.ts";
import type { Env, PhoneBindingRow, RemoteReplyRow, RemoteThreadRow } from "../src/types.ts";

async function ownerIdForToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`remote-control:${token}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DEV_OWNER_ID = await ownerIdForToken("dev-token");

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
  threads = new Map<string, RemoteThreadRow>();
  replies = new Map<string, RemoteReplyRow>();
  phoneBindings = new Map<string, PhoneBindingRow>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO remote_threads")) {
      const [id, ownerId, cwd, title, handoffSummary, pairingCode, createdAt, updatedAt] = values as string[];
      const existing = this.threads.get(id);
      this.threads.set(id, {
        id,
        owner_id: ownerId,
        cwd,
        title: title ?? null,
        handoff_summary: handoffSummary ?? null,
        status: "enabled",
        remote_enabled: 1,
        pairing_code: pairingCode,
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

    if (sql.includes("UPDATE remote_threads") && sql.includes("pairing_code = NULL") && !sql.includes("remote_enabled = 0")) {
      if (sql.includes("WHERE owner_id = ?")) {
        const [updatedAt, ownerId, excludedId] = values as string[];
        for (const thread of this.threads.values()) {
          if (thread.owner_id === ownerId && thread.id !== excludedId) {
            thread.pairing_code = null;
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
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE remote_threads") && sql.includes("remote_enabled = 0")) {
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.status = "stopped";
      thread.remote_enabled = 0;
      thread.pairing_code = null;
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE remote_threads SET updated_at = ? WHERE id = ?")) {
      const [updatedAt, id] = values as string[];
      const thread = this.threads.get(id);
      if (!thread) {
        return { meta: { changes: 0 } };
      }
      thread.updated_at = updatedAt;
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE remote_threads")) {
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

    if (sql.includes("INSERT INTO remote_replies")) {
      const [id, threadId, externalId, body, media, mediaGroupId, mediaIndex, status, createdAt, appliedAt] = values as Array<string | number | null>;
      this.replies.set(String(id), {
        id: String(id),
        thread_id: String(threadId),
        external_id: externalId === null ? null : String(externalId),
        body: String(body),
        media: media === null ? null : String(media),
        media_group_id: mediaGroupId === null ? null : String(mediaGroupId),
        media_index: mediaIndex === null ? null : Number(mediaIndex),
        status: status as RemoteReplyRow["status"],
        created_at: String(createdAt),
        applied_at: appliedAt === null ? null : String(appliedAt),
      });
      return { meta: { changes: 1 } };
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
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (sql.includes("UPDATE remote_replies") && sql.includes("media_group_id = ?")) {
      const [appliedAt, threadId, mediaGroupId] = values as string[];
      let changes = 0;
      for (const reply of this.replies.values()) {
        if (reply.thread_id === threadId && reply.media_group_id === mediaGroupId && reply.status === "pending") {
          reply.status = "applied";
          reply.body = "";
          reply.media = null;
          reply.applied_at = appliedAt;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (sql.includes("UPDATE remote_replies")) {
      const [appliedAt, id, threadId] = values as string[];
      const reply = this.replies.get(id);
      if (!reply || reply.thread_id !== threadId || reply.status !== "pending") {
        return { meta: { changes: 0 } };
      }
      reply.status = "applied";
      reply.body = "";
      reply.media = null;
      reply.applied_at = appliedAt;
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

    if (sql.includes("SELECT * FROM remote_threads WHERE pairing_code = ?")) {
      const pairingCode = String(values[0]);
      return ([...this.threads.values()].find((thread) => thread.pairing_code === pairingCode && thread.remote_enabled === 1) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM remote_threads")) {
      return (this.threads.get(String(values[0])) ?? null) as T | null;
    }

    if (sql.includes("SELECT id FROM remote_replies WHERE external_id = ?")) {
      const externalId = String(values[0]);
      const reply = [...this.replies.values()].find((candidate) => candidate.external_id === externalId);
      return (reply ? { id: reply.id } : null) as T | null;
    }

    if (sql.includes("FROM phone_bindings WHERE active_thread_id = ?")) {
      const threadId = String(values[0]);
      return ([...this.phoneBindings.values()].find((binding) => binding.active_thread_id === threadId) ?? null) as T | null;
    }

    if (sql.includes("SELECT * FROM remote_replies WHERE id = ?")) {
      const reply = this.replies.get(String(values[0]));
      if (!reply || reply.thread_id !== values[1] || reply.status !== "pending") {
        return null;
      }
      return reply as T;
    }

    if (sql.includes("SELECT id, body, created_at FROM remote_replies WHERE id = ?")) {
      const reply = this.replies.get(String(values[0]));
      if (!reply || reply.thread_id !== values[1]) {
        return null;
      }
      return reply as T;
    }

    throw new Error(`Unexpected first SQL: ${sql}`);
  }

  all<T>(sql: string, values: unknown[]) {
    if (sql.includes("FROM remote_threads") && sql.includes("remote_enabled = 1")) {
      const ownerId = String(values[0]);
      const results = [...this.threads.values()]
        .filter((thread) => thread.owner_id === ownerId && thread.remote_enabled === 1)
        .sort((a, b) => (
          b.updated_at.localeCompare(a.updated_at)
          || b.created_at.localeCompare(a.created_at)
          || b.id.localeCompare(a.id)
        )) as T[];
      return { results };
    }

    if (sql.includes("FROM remote_replies") && sql.includes("status = 'pending'")) {
      const threadId = String(values[0]);
      let results = [...this.replies.values()]
        .filter((reply) => reply.thread_id === threadId && reply.status === "pending")
        .sort((a, b) => (
          (a.media_index ?? 0) - (b.media_index ?? 0)
          || a.created_at.localeCompare(b.created_at)
        ));
      if (sql.includes("media_group_id = ?")) {
        const mediaGroupId = String(values[1]);
        results = results.filter((reply) => reply.media_group_id === mediaGroupId);
      }
      return { results };
    }

    throw new Error(`Unexpected all SQL: ${sql}`);
  }
}

function env() {
  return {
    DB: new FakeD1Database() as unknown as D1Database,
    SENDBLUE_API_KEY: "sendblue-key",
    SENDBLUE_SECRET_KEY: "sendblue-secret",
    SENDBLUE_WEBHOOK_SECRET: "webhook-secret",
    SENDBLUE_FROM_NUMBER: "+16452468235",
    SENDBLUE_API_BASE_URL: "https://api.sendblue.test/api",
    SENDBLUE_TYPING_DELAY_MS: "0",
  } satisfies Env;
}

function attachRelayBuffer(testEnv: Env) {
  const relay = new RemoteThreadSocket({
    acceptWebSocket() {},
    getWebSockets() {
      return [];
    },
  } as unknown as DurableObjectState);
  testEnv.REMOTE_THREAD_SOCKET = {
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
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://remote-control.test${path}`, {
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

async function notification(response: Response) {
  return (await json(response)).notification as Record<string, unknown>;
}

async function register(testEnv: Env, overrides: Record<string, unknown> = {}) {
  const threadId = "thread-test-1";
  const response = await handleRequest(req(`/threads/${threadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({ cwd: "/tmp/project", title: "Remote test", ...overrides }),
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

test("creates install tokens", async () => {
  const testEnv = env();
  const response = await handleRequest(req("/installations", { method: "POST" }), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(typeof body.token, "string");
  assert.match(String(body.token), /^rc_[a-f0-9]{64}$/);
});

test("creates and upserts a remote thread with an explicit id", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const upsert = await handleRequest(req(`/threads/${threadId}`, {
    method: "POST",
    headers: { authorization: "Bearer dev-token" },
    body: JSON.stringify({
      cwd: "/tmp/project-renamed",
      title: "Remote test updated",
      handoffSummary: "You were reviewing remote handoff copy.",
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
  assert.equal(body.cwd, "/tmp/project-renamed");
  assert.equal(body.title, "Remote test updated");
  assert.equal(body.handoffSummary, "You were reviewing remote handoff copy.");
  assert.equal(body.status, "enabled");
  assert.equal(body.remoteEnabled, true);
});

test("proxies authorized thread websocket upgrades to the Durable Object", async () => {
  const testEnv: Env = env();
  const threadId = await register(testEnv);
  const calls: Array<{ name: string; url: string }> = [];
  testEnv.REMOTE_THREAD_SOCKET = {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        id,
        fetch: async (request: Request) => {
          calls.push({ name: (id as unknown as { name: string }).name, url: request.url });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;

  const response = await handleRequest(req(`/threads/${threadId}/events?token=dev-token`, {
    headers: { upgrade: "websocket" },
  }), testEnv);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    name: "global",
    url: `https://remote-control.test/threads/${threadId}/events?token=dev-token`,
  }]);
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
  const relay = new RemoteThreadSocket({
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

  const response = await relay.fetch(new Request("https://remote-control.internal/threads/thread-test-1/replies", {
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
  const relay = new RemoteThreadSocket({
    acceptWebSocket() {},
    getWebSockets() {
      return [];
    },
  } as unknown as DurableObjectState);

  await relay.fetch(new Request("https://remote-control.internal/threads/thread-test-1/replies", {
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
  const relay = new RemoteThreadSocket({
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
    await relay.fetch(new Request("https://remote-control.internal/threads/thread-test-1/replies", {
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
    for (const reply of (relay as unknown as { replies: Map<string, RemoteReplyRow> }).replies.values()) {
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
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [null, {
      number: "+15551234567",
      from_number: "+16452468235",
      content: 'You’re connected to "Remote test" on Codex.\n\nYou were deciding what the first playable prototype should include.\n\nWhat do you want to do next?',
    }]);

    const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.deepEqual((await json(pending)).replies, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  assert.deepEqual(calls.map((call) => call?.content), [
    'You’re connected to "Remote test" on Codex.\n\nWhat do you want to do next?',
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
  assert.deepEqual(calls.map((call) => call?.content), [
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
    assert.deepEqual(calls.map((call) => call.url), [
      "https://api.sendblue.test/api/evaluate-service?number=%2B15551234567",
      "https://api.sendblue.test/api/send-message",
    ]);
    assert.deepEqual(calls.map((call) => call.body), [null, {
      number: "+15551234567",
      from_number: "+16452468235",
      content: "Remote Control only supports phone numbers that use iMessage for now.",
    }]);
    const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.deepEqual((await json(pending)).replies, []);
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
  const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(pending) as { replies: Array<{ body: string }> };
  assert.equal(body.replies.length, 1);
  assert.equal(body.replies[0]?.body, "What is 2 + 2?");
});

test("relay buffer keeps inbound message content out of D1", async () => {
  const testEnv = env();
  attachRelayBuffer(testEnv);
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundMessage("What is buffered?", "msg_buffered")), testEnv);
  assert.equal(response.status, 200);
  assert.equal([...db.replies.values()].some((reply) => reply.body === "What is buffered?"), false);

  const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(pending) as { replies: Array<{ id: string; body: string }> };
  assert.equal(body.replies.length, 1);
  assert.equal(body.replies[0]?.body, "What is buffered?");

  const replyId = body.replies[0]?.id;
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

  const emptyPending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  assert.deepEqual((await json(emptyPending)).replies, []);
});

test("image-only sendblue webhook creates a pending media reply after quiet window", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  const response = await handleRequest(sendblueWebhook(inboundImage("", "https://cdn.example.test/cow.jpg", "img_1")), testEnv);
  assert.equal(response.status, 200);
  const reply = [...db.replies.values()].find((candidate) => candidate.status === "pending");
  assert.equal(reply?.body, "");
  assert.deepEqual(JSON.parse(String(reply?.media)), [{ url: "https://cdn.example.test/cow.jpg" }]);
  assert.equal(reply?.media_group_id, "img");
  assert.equal(reply?.media_index, 1);
  if (reply) {
    reply.created_at = "2026-04-25T18:30:00.000Z";
  }

  const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(pending) as { replies: Array<{ body: string; media: Array<{ url: string }> }> };
  assert.equal(body.replies.length, 1);
  assert.equal(body.replies[0]?.body, "");
  assert.deepEqual(body.replies[0]?.media, [{ url: "https://cdn.example.test/cow.jpg" }]);
});

test("text plus image webhook stores both body and media", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);

  await handleRequest(sendblueWebhook(inboundImage("What is this?", "https://cdn.example.test/photo.png", "img_2")), testEnv);
  const reply = [...db.replies.values()].find((candidate) => candidate.status === "pending");
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

  const freshPending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  assert.deepEqual((await json(freshPending)).replies, []);

  for (const reply of db.replies.values()) {
    if (reply.status === "pending") {
      reply.created_at = reply.media_index === 1 ? "2026-04-25T18:30:00.000Z" : "2026-04-25T18:30:01.000Z";
    }
  }

  const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const pendingBody = await json(pending) as { replies: Array<{ id: string; body: string; media: Array<{ url: string }> }> };
  assert.equal(pendingBody.replies.length, 1);
  assert.equal(pendingBody.replies[0]?.body, "Compare these");
  assert.deepEqual(pendingBody.replies[0]?.media, [
    { url: "https://cdn.example.test/one.png" },
    { url: "https://cdn.example.test/two.png" },
  ]);
  const firstReplyId = pendingBody.replies[0]?.id;
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
    const tombstones = [...db.replies.values()].filter((reply) => reply.media_group_id === "group");
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

  const pendingReplies = [...db.replies.values()].filter((reply) => reply.status === "pending");
  assert.equal(pendingReplies.length, 2);
  assert.deepEqual(pendingReplies.map((reply) => reply.body), ["list", "1"]);
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
        handoffSummary: "You were choosing the next remote task.",
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
  assert.deepEqual(calls.map((call) => call.content), ['You’re connected to "Second" on Codex.\n\nYou were choosing the next remote task.\n\nWhat do you want to do next?']);
  assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, secondThreadId);
  assert.equal(db.threads.get(secondThreadId)?.pairing_code, null);

  await handleRequest(sendblueWebhook(inboundMessage("Use the new one", "msg_2")), testEnv);
  const firstPending = await handleRequest(req(`/threads/${firstThreadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const secondPending = await handleRequest(req(`/threads/${secondThreadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  assert.deepEqual((await json(firstPending)).replies, []);
  assert.equal(((await json(secondPending)) as { replies: unknown[] }).replies.length, 1);
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
    assert.deepEqual(calls.map((call) => call.content), [
      "Remote threads:\n\n1. Second (current)\n2. Remote test\n\nReply with a number to switch.",
    ]);
    assert.doesNotMatch(String(calls[0]?.content), /enabled|stopped/i);
    const pending = [...db.replies.values()].filter((reply) => reply.status === "pending");
    assert.deepEqual(pending, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("list command reports when the paired phone has no remote threads", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  db.threads.get(threadId)!.remote_enabled = 0;
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
    assert.deepEqual(calls.map((call) => call.content), ["You have no remote codex threads"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal text reports when there is no active thread to forward to", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  db.threads.get(threadId)!.remote_enabled = 0;
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
    assert.deepEqual(calls.map((call) => call.content), ["You have no remote codex threads"]);
    const pending = [...db.replies.values()].filter((reply) => reply.status === "pending");
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
    assert.deepEqual(calls.map((call) => call.content), ['Switched to "Remote test".']);

    await handleRequest(sendblueWebhook(inboundMessage("Now use the first thread", "msg_2")), testEnv);
    const firstPending = await handleRequest(req(`/threads/${firstThreadId}/pending`, {
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    const secondPending = await handleRequest(req(`/threads/${secondThreadId}/pending`, {
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(((await json(firstPending)) as { replies: unknown[] }).replies.length, 1);
    assert.deepEqual((await json(secondPending)).replies, []);
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
    assert.deepEqual(calls.map((call) => call.content), ["Text threads to see active remote threads."]);
    const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.deepEqual((await json(pending)).replies, []);
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
    assert.equal(db.threads.get(secondThreadId)?.remote_enabled, 0);
    assert.equal(db.phoneBindings.get("+15551234567")?.active_thread_id, firstThreadId);

    await handleRequest(sendblueWebhook(inboundMessage("list", "list_after_stop")), testEnv);
    assert.deepEqual(calls.map((call) => call.content), [
      "Remote threads:\n\n1. Remote test (current)\n\nReply with a number to switch.",
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

  const oldCodeResponse = await handleRequest(sendblueWebhook(inboundMessage(String(firstCode), "old_pair_msg")), testEnv);
  assert.equal(oldCodeResponse.status, 200);
  assert.equal((await json(oldCodeResponse)).ignored, true);
});

test("unknown senders are acknowledged without enqueueing", async () => {
  const testEnv = env();
  const response = await handleRequest(sendblueWebhook(inboundMessage("hello", "msg_unknown")), testEnv);
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.ignored, true);
});

test("duplicate sendblue message handles are ignored", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("once", "msg_2")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("twice", "msg_2")), testEnv);

  const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(pending) as { replies: Array<{ body: string }> };
  assert.deepEqual(body.replies.map((reply) => reply.body), ["once"]);
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

test("lists pending replies from paired Sendblue texts", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("Append a line", "msg_2")), testEnv);

  const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer dev-token" },
  }), testEnv);
  const body = await json(pending) as { replies: Array<{ id: string; body: string }> };
  assert.equal(body.replies.length, 1);
  assert.equal(body.replies[0]?.body, "Append a line");
});

test("claims a pending reply exactly once", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  await handleRequest(sendblueWebhook(inboundMessage(String(db.threads.get(threadId)?.pairing_code), "pair_msg_1")), testEnv);
  await handleRequest(sendblueWebhook(inboundMessage("Do it once", "msg_2")), testEnv);
  const replyId = [...db.replies.values()].find((reply) => reply.status === "pending")?.id;
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
        from_number: "+16452468235",
      },
    }]);

    const duplicate = await handleRequest(req(`/threads/${threadId}/replies/${replyId}/claim`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    assert.equal(duplicate.status, 409);

    const pending = await handleRequest(req(`/threads/${threadId}/pending`, {
      headers: { authorization: "Bearer dev-token" },
    }), testEnv);
    const body = await json(pending) as { replies: unknown[] };
    assert.deepEqual(body.replies, []);
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
      from_number: "+16452468235",
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

    assert.deepEqual(calls.map((call) => call.content), ["81", "Created TEMP."]);
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
          from_number: "+16452468235",
          media_url: "https://cdn.sendblue.test/cow.png",
        },
      },
    ]);
    assert.equal((await notification(status)).messageHandle, "message-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends text and one generated image together", async () => {
  const testEnv = env();
  const threadId = await register(testEnv);
  const db = testEnv.DB as unknown as FakeD1Database;
  db.phoneBindings.set("+15551234567", {
    phone_number: "+15551234567",
    owner_id: DEV_OWNER_ID,
    active_thread_id: threadId,
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
        from_number: "+16452468235",
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
      from_number: "+16452468235",
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
      from_number: "+16452468235",
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
  const response = await handleRequest(req(`/threads/${threadId}/pending`, {
    headers: { authorization: "Bearer wrong-token" },
  }), testEnv);
  assert.equal(response.status, 401);
});
