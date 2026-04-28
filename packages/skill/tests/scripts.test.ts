import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const scriptsDir = path.resolve("skill/remote-control/scripts");

function scriptEnv(options: { stateDir: string; mockFile?: string; codexThreadId?: string; stateDb?: string; sessionLog?: string; globalState?: string }) {
  return {
    ...process.env,
    CODEX_THREAD_ID: options.codexThreadId ?? "",
    REMOTE_CONTROL_STATE_DIR: options.stateDir,
    REMOTE_CONTROL_TOKEN: "dev-token",
    REMOTE_CONTROL_MOCK_FILE: options.mockFile ?? "",
    REMOTE_CONTROL_STATE_DB: options.stateDb ?? "",
    REMOTE_CONTROL_SESSION_LOG: options.sessionLog ?? "",
    REMOTE_CONTROL_GLOBAL_STATE_PATH: options.globalState ?? "",
  };
}

function runScript(scriptName: string, args: string[], options: { stateDir: string; stdin?: string; mockFile?: string; codexThreadId?: string; stateDb?: string; sessionLog?: string; globalState?: string }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, scriptName), ...args], {
      cwd: path.resolve("."),
      env: scriptEnv(options),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(options.stdin ?? "");
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempState() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "http://127.0.0.1:9",
    token: "dev-token",
  }));
  return stateDir;
}

function mockFile(responses: Record<string, unknown>) {
  const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "remote-control-mock-")), "mock.json");
  writeFileSync(filePath, JSON.stringify({ responses, calls: [] }));
  return filePath;
}

function makePng(name: string, content: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "remote-control-image-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, Buffer.from(content));
  return filePath;
}

function makeSessionLog(rows: unknown[]) {
  const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "remote-control-session-")), "session.jsonl");
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return filePath;
}

function makeGlobalState(queuedFollowUps: Record<string, unknown[]>) {
  const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "remote-control-global-state-")), "global-state.json");
  writeFileSync(filePath, JSON.stringify({
    "queued-follow-ups": queuedFollowUps,
  }));
  return filePath;
}

function makeCodexStateDb(rows: Array<{ id: string; title: string }>) {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "remote-control-state-db-")), "state_5.sqlite");
  const create = spawnSync("sqlite3", [dbPath, "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL);"], { encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr);
  for (const row of rows) {
    const insert = spawnSync("sqlite3", [
      dbPath,
      "INSERT INTO threads (id, title) VALUES (" + sqlString(row.id) + ", " + sqlString(row.title) + ");",
    ], { encoding: "utf8" });
    assert.equal(insert.status, 0, insert.stderr);
  }
  return dbPath;
}

function sqlString(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

test("publish-stop exits quietly for inactive threads", async () => {
  const stateDir = tempState();
  const result = await runScript("publish-stop.js", [], {
    stateDir,
    stdin: JSON.stringify({ session_id: "session-1", cwd: "/tmp/project" }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("start-remote requires CODEX_THREAD_ID", async () => {
  const stateDir = tempState();
  const result = await runScript("start-remote.js", [], { stateDir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CODEX_THREAD_ID is required/);
});

test("start-remote creates thread and writes active registry", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+16452468235",
        paired: false,
        pairingRequired: true,
        pairingCode: "ABC123",
        skipNextStatusSend: false,
      },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));

  const result = await runScript("start-remote.js", [
    "--cwd=/tmp/project",
    "--handoff-summary=You were deciding what to prototype next.",
  ], { stateDir, mockFile: mockPath, codexThreadId: "codex-thread-1" });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.codexThreadId, "codex-thread-1");
  assert.equal(parsed.sendblueNumber, "+16452468235");
  assert.equal(parsed.sendblueNumberDisplay, "+1 (645) 246-8235");
  assert.equal(parsed.paired, false);
  assert.equal(parsed.pairingRequired, true);
  assert.equal(parsed.pairingCode, "ABC123");
  assert.equal(parsed.localMessage, "Remote control is enabled. Text `ABC123` to `+1 (645) 246-8235` to continue this thread from iMessage.");
  assert.match(parsed.statusCurlCommand, /curl -sS/);
  assert.match(parsed.statusCurlCommand, /\/threads\/codex-thread-1/);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].cwd, "/tmp/project");
  assert.equal(active.threads["codex-thread-1"].lastStopAt, null);
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, false);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].path, "/threads/codex-thread-1");
  assert.equal(mock.calls[0].authorization, "Bearer dev-token");
  assert.equal("userId" in mock.calls[0].body, false);
  assert.equal(mock.calls[0].body.cwd, "/tmp/project");
  assert.equal("title" in mock.calls[0].body, false);
  assert.equal(mock.calls[0].body.handoffSummary, "You were deciding what to prototype next.");
});

test("start-remote uses the Codex sidebar title from the local state db", async () => {
  const stateDb = makeCodexStateDb([
    { id: "codex-thread-1", title: "Create remote-control app" },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+16452468235",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-remote.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
    stateDb,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.localMessage, "Remote control is enabled. Text `+1 (645) 246-8235` to talk to Codex.");
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, true);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.title, "Create remote-control app");
  assert.equal("handoffSummary" in mock.calls[0].body, false);
});

test("start-remote sends normalized skill-link titles", async () => {
  const stateDb = makeCodexStateDb([
    { id: "codex-thread-1", title: "[$remote-control](/Users/gabe/.codex/skills/remote-control/SKILL.md)" },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+16452468235",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-remote.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
    stateDb,
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.title, "$remote-control");
});

test("start-remote allows activation-only titles", async () => {
  const stateDb = makeCodexStateDb([
    { id: "codex-thread-1", title: "Start remote control" },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+16452468235",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-remote.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
    stateDb,
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.title, "Start remote control");
});

test("start-remote omits empty handoff summaries", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+16452468235",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-remote.js", ["--cwd=/tmp/project", "--handoff-summary=   "], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal("handoffSummary" in mock.calls[0].body, false);
});

test("start-remote resets local activation time when re-enabling a thread", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+16452468235",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/old",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: "2026-04-25T18:30:00.000Z",
        sentGeneratedImageEvents: ["old-image"],
      },
    },
  }));

  const before = Date.now();
  const result = await runScript("start-remote.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
  });
  assert.equal(result.code, 0);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].cwd, "/tmp/project");
  assert.equal(active.threads["codex-thread-1"].lastStopAt, null);
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, true);
  assert.deepEqual(active.threads["codex-thread-1"].sentGeneratedImageEvents, ["old-image"]);
  assert.equal(Date.parse(active.threads["codex-thread-1"].createdAt) >= before, true);
});

test("publish-stop exits immediately without active thread", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = tempState();

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls?.length ?? 0, 0);
});

test("publish-stop exits quietly after status when no remote reply is pending", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": { body: { replies: [] } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(mock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/status",
    "GET /threads/codex-thread-1/pending",
  ]);
  assert.deepEqual(mock.websocketCalls.map((call: { method: string; path: string; body: { type: string } }) => ({
    method: call.method,
    path: call.path,
    type: call.body.type,
  })), [{
    method: "WS",
    path: "/threads/codex-thread-1/events",
    type: "stop-hook-connected",
  }]);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].lastStopAt !== null, true);
});

test("publish-stop ignores session-log local messages unless a local follow-up is queued", async () => {
  const sessionLog = makeSessionLog([
    {
      timestamp: "2026-04-25T18:21:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "I'm back at my desk\n" }],
      },
    },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": { body: { replies: [] } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    sessionLog,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Local answer.",
    }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(mock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/status",
    "GET /threads/codex-thread-1/pending",
  ]);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(Boolean(active.threads["codex-thread-1"]), true);
});

test("publish-stop silently exits during polling when a transient local follow-up is queued", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": { body: { replies: [] } },
    "POST /threads/codex-thread-1/stop": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  const globalState = makeGlobalState({});
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 3,
    stopPollIntervalSeconds: 1,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const child = spawn(process.execPath, [path.join(scriptsDir, "publish-stop.js")], {
    cwd: path.resolve("."),
    env: scriptEnv({ stateDir, mockFile: mockPath, globalState }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  const closed = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(JSON.stringify({
    session_id: "codex-thread-1",
    cwd: "/tmp/project",
    last_assistant_message: "Done.",
  }));

  await wait(100);
  writeFileSync(globalState, JSON.stringify({
    "queued-follow-ups": {
      "codex-thread-1": [{ id: "follow-up-1", text: "local message" }],
    },
  }));
  await wait(600);
  writeFileSync(globalState, JSON.stringify({ "queued-follow-ups": {} }));

  assert.equal((await closed), 0);
  assert.equal(stdout, "");
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  const calls = mock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`);
  assert.equal(calls[0], "POST /threads/codex-thread-1/status");
  assert.equal(calls.at(-1), "POST /threads/codex-thread-1/stop");
  assert.equal(calls.filter((call: string) => call === "POST /threads/codex-thread-1/stop").length, 1);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.deepEqual(active.threads, {});
});

test("publish-stop claims a remote reply and emits a block decision", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": {
      body: {
        replies: [
          { id: "reply_1", body: "What is 2 + 2?", createdAt: "2026-04-25T18:30:00.000Z" },
        ],
      },
    },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: { ok: true, reply: { id: "reply_1", body: "What is 2 + 2?" } },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /Local display block to render:\n\*\*Remote message\*\*\n> What is 2 \+ 2\?/);
  assert.match(parsed.reason, /Start your assistant response with the local display block/);
  assert.match(parsed.reason, /User message to answer:\nWhat is 2 \+ 2\?/);
  assert.doesNotMatch(parsed.reason, /empty response/);
  assert.doesNotMatch(parsed.reason, /connectivity test/);
  assert.doesNotMatch(parsed.reason, /claimed reply/i);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(mock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/status",
    "GET /threads/codex-thread-1/pending",
    "POST /threads/codex-thread-1/replies/reply_1/claim",
  ]);
  assert.equal(mock.calls[2].body, null);
});

test("publish-stop formats multi-line remote replies including blank lines", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": {
      body: {
        replies: [
          { id: "reply_1", body: "First line\n\nThird line", createdAt: "2026-04-25T18:30:00.000Z" },
        ],
      },
    },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: { ok: true, reply: { id: "reply_1", body: "First line\n\nThird line" } },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.reason, /\*\*Remote message\*\*\n> First line\n>  \n> Third line/);
  assert.match(parsed.reason, /User message to answer:\nFirst line\n\nThird line/);
});

test("publish-stop downloads one remote image and includes the local path", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": {
      body: {
        replies: [
          {
            id: "reply_1",
            body: "What is this?",
            media: [{ url: "https://cdn.example.test/cow.jpg" }],
            createdAt: "2026-04-25T18:30:00.000Z",
          },
        ],
      },
    },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: {
        ok: true,
        reply: {
          id: "reply_1",
          body: "What is this?",
          media: [{ url: "https://cdn.example.test/cow.jpg" }],
        },
      },
    },
  });
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.mediaResponses = {
    "https://cdn.example.test/cow.jpg": {
      contentType: "image/jpeg",
      dataBase64: Buffer.from("cow-bytes").toString("base64"),
    },
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  const expectedPath = path.join(stateDir, "attachments", "codex-thread-1", "reply_1", "image-1.jpg");
  assert.equal(readFileSync(expectedPath, "utf8"), "cow-bytes");
  assert.match(parsed.reason, new RegExp(`Attached images:\\n1\\. ${expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("publish-stop downloads multiple remote images in order", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": {
      body: {
        replies: [
          {
            id: "reply_group",
            body: "Compare these",
            media: [
              { url: "https://cdn.example.test/one.png" },
              { url: "https://cdn.example.test/two.webp" },
            ],
            createdAt: "2026-04-25T18:30:00.000Z",
          },
        ],
      },
    },
    "POST /threads/codex-thread-1/replies/reply_group/claim": {
      body: {
        ok: true,
        reply: {
          id: "reply_group",
          body: "Compare these",
          media: [
            { url: "https://cdn.example.test/one.png" },
            { url: "https://cdn.example.test/two.webp" },
          ],
        },
      },
    },
  });
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.mediaResponses = {
    "https://cdn.example.test/one.png": {
      contentType: "image/png",
      dataBase64: Buffer.from("one").toString("base64"),
    },
    "https://cdn.example.test/two.webp": {
      contentType: "image/webp",
      dataBase64: Buffer.from("two").toString("base64"),
    },
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  const firstPath = path.join(stateDir, "attachments", "codex-thread-1", "reply_group", "image-1.png");
  const secondPath = path.join(stateDir, "attachments", "codex-thread-1", "reply_group", "image-2.webp");
  assert.equal(readFileSync(firstPath, "utf8"), "one");
  assert.equal(readFileSync(secondPath, "utf8"), "two");
  assert.match(parsed.reason, new RegExp(`1\\. ${firstPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n2\\. ${secondPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("publish-stop reports a clear error when remote image download fails", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": {
      body: {
        replies: [
          {
            id: "reply_1",
            body: "Inspect this",
            media: [{ url: "https://cdn.example.test/missing.jpg" }],
            createdAt: "2026-04-25T18:30:00.000Z",
          },
        ],
      },
    },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: {
        ok: true,
        reply: {
          id: "reply_1",
          body: "Inspect this",
          media: [{ url: "https://cdn.example.test/missing.jpg" }],
        },
      },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.match(parsed.reason, /Attached images could not be downloaded: No mock media response/);
});

test("publish-stop exits without polling when active entry is missing", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 0,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({ threads: {} }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done.",
    }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls?.length ?? 0, 0);
});

test("publish-stop exits during polling after stop-remote removes the active entry", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "GET /threads/codex-thread-1/pending": { body: { replies: [] } },
    "POST /threads/codex-thread-1/stop": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopPollSeconds: 3,
    stopPollIntervalSeconds: 1,
  }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const child = spawn(process.execPath, [path.join(scriptsDir, "publish-stop.js")], {
    cwd: path.resolve("."),
    env: scriptEnv({ stateDir, mockFile: mockPath }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  const closed = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(JSON.stringify({
    session_id: "codex-thread-1",
    cwd: "/tmp/project",
    last_assistant_message: "Done.",
  }));

  await wait(100);
  const stop = await runScript("stop-remote.js", [], { stateDir, mockFile: mockPath, codexThreadId: "codex-thread-1" });
  assert.equal(stop.code, 0);
  assert.equal((await closed), 0);
  assert.equal(stdout, "");
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"], undefined);
});

test("stop-remote removes the current codex thread", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/stop": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": { cwd: "/tmp/project", createdAt: "2026-04-25T18:20:00.000Z", lastStopAt: null },
      "codex-thread-2": { cwd: "/tmp/project", createdAt: "2026-04-25T18:21:00.000Z", lastStopAt: null },
    },
  }));

  const result = await runScript("stop-remote.js", [], { stateDir, mockFile: mockPath, codexThreadId: "codex-thread-1" });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.removedCount, 1);
  assert.deepEqual(parsed.codexThreadIds, ["codex-thread-1"]);
  assert.equal(parsed.serverStopped, true);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"], undefined);
  assert.equal(Boolean(active.threads["codex-thread-2"]), true);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(mock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/stop",
  ]);
});

test("stop-remote requires a codex thread id", async () => {
  const stateDir = tempState();
  const result = await runScript("stop-remote.js", [], { stateDir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CODEX_THREAD_ID is required/);
});

test("publish-stop stores empty assistant messages as null", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "   ",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, null);
});

test("publish-stop preserves substantive assistant summaries", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Done. I created remote-test.txt.",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, "Done. I created remote-test.txt.");
});

test("publish-stop skips the local start-remote activation status once", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
        skipNextStatusSend: true,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Remote control is enabled. Text `+1 (645) 246-8235` to talk to Codex.",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, null);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, false);
});

test("publish-stop strips local-only remote message blocks before publishing status", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: [
        "**Remote message**",
        "> What time is it?",
        "",
        "It's 8:57 PM PDT on Saturday, April 25, 2026.",
      ].join("\n"),
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, "It's 8:57 PM PDT on Saturday, April 25, 2026.");
});

test("publish-stop strips local-only remote message blocks when the header is quoted", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: [
        "> **Remote message**",
        "> Lfg",
        "",
        "Great - I'm ready. What do you want to start with?",
      ].join("\n"),
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, "Great - I'm ready. What do you want to start with?");
});

test("publish-stop strips multi-line local display blocks before publishing status", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: [
        "**Remote message**",
        "> First line",
        ">  ",
        "> Third line",
        "",
        "Answered.",
      ].join("\n"),
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, "Answered.");
});

test("publish-stop includes new generated images from the session log", async () => {
  const imagePath = makePng("cow.png", "png-one");
  const sessionLog = makeSessionLog([
    {
      timestamp: "2026-04-25T18:20:30.000Z",
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "image-call-1",
        saved_path: imagePath,
      },
    },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    sessionLog,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.generatedImages.length, 1);
  assert.equal(mock.calls[0].body.generatedImages[0].eventId, "image-call-1");
  assert.equal(mock.calls[0].body.generatedImages[0].filename, "cow.png");
  assert.equal(mock.calls[0].body.generatedImages[0].dataBase64, Buffer.from("png-one").toString("base64"));
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.deepEqual(active.threads["codex-thread-1"].sentGeneratedImageEvents, ["image-call-1"]);
  assert.equal(active.threads["codex-thread-1"].sessionLogPath, sessionLog);
});

test("publish-stop skips generated images that were already sent", async () => {
  const imagePath = makePng("cow.png", "png-one");
  const sessionLog = makeSessionLog([
    {
      timestamp: "2026-04-25T18:20:30.000Z",
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "image-call-1",
        saved_path: imagePath,
      },
    },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
        sentGeneratedImageEvents: ["image-call-1"],
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    sessionLog,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(mock.calls[0].body.generatedImages, []);
});

test("publish-stop keeps generated images retryable when notification fails", async () => {
  const imagePath = makePng("cow.png", "png-one");
  const sessionLog = makeSessionLog([
    {
      timestamp: "2026-04-25T18:20:30.000Z",
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        call_id: "image-call-1",
        saved_path: imagePath,
      },
    },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": {
      body: { ok: true, notification: { sent: false, status: "ERROR" } },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    sessionLog,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "",
    }),
  });
  assert.equal(result.code, 0);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.deepEqual(active.threads["codex-thread-1"].sentGeneratedImageEvents, []);
  assert.equal(active.threads["codex-thread-1"].lastGeneratedImageScanAt, undefined);
});

test("publish-stop preserves multiple generated images in order", async () => {
  const firstImagePath = makePng("first.png", "png-one");
  const secondImagePath = makePng("second.png", "png-two");
  const sessionLog = makeSessionLog([
    {
      timestamp: "2026-04-25T18:20:30.000Z",
      type: "event_msg",
      payload: { type: "image_generation_end", call_id: "image-call-1", saved_path: firstImagePath },
    },
    {
      timestamp: "2026-04-25T18:20:31.000Z",
      type: "event_msg",
      payload: { type: "image_generation_end", call_id: "image-call-2", saved_path: secondImagePath },
    },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "remote-control-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": {
        cwd: "/tmp/project",
        createdAt: "2026-04-25T18:20:00.000Z",
        lastStopAt: null,
      },
    },
  }));

  const result = await runScript("publish-stop.js", [], {
    stateDir,
    mockFile: mockPath,
    sessionLog,
    stdin: JSON.stringify({
      session_id: "codex-thread-1",
      cwd: "/tmp/project",
      last_assistant_message: "Two images.",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(mock.calls[0].body.generatedImages.map((image: { filename: string }) => image.filename), ["first.png", "second.png"]);
});
