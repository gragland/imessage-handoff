import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const scriptsDir = path.resolve("imessage-handoff/scripts");

// These tests execute the installed skill scripts the same way Codex hooks do.
// Most network calls are routed through a mock file so the tests can verify the
// local state machine without needing a live relay or Sendblue account.
function scriptEnv(options: { stateDir: string; mockFile?: string; codexThreadId?: string; stateDb?: string; sessionLog?: string; globalState?: string; codexHome?: string; relayUrl?: string }) {
  const env = {
    ...process.env,
    CODEX_HOME: options.codexHome ?? path.join(options.stateDir, "codex-home"),
    CODEX_THREAD_ID: options.codexThreadId ?? "",
    IMESSAGE_HANDOFF_STATE_DIR: options.stateDir,
    IMESSAGE_HANDOFF_TOKEN: "dev-token",
    IMESSAGE_HANDOFF_MOCK_FILE: options.mockFile ?? "",
    IMESSAGE_HANDOFF_STATE_DB: options.stateDb ?? "",
    IMESSAGE_HANDOFF_SESSION_LOG: options.sessionLog ?? "",
    IMESSAGE_HANDOFF_GLOBAL_STATE_PATH: options.globalState ?? "",
  };
  if (options.relayUrl) {
    env.IMESSAGE_HANDOFF_RELAY_URL = options.relayUrl;
  }
  return env;
}

function runScript(scriptName: string, args: string[], options: { stateDir: string; stdin?: string; mockFile?: string; codexThreadId?: string; stateDb?: string; sessionLog?: string; globalState?: string; codexHome?: string; relayUrl?: string }) {
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

function runCli(args: string[]) {
  return spawnSync(process.execPath, [path.resolve("bin/imessage-handoff.mjs"), ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMockCall(mockPath: string, expected: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mock = JSON.parse(readFileSync(mockPath, "utf8"));
    const calls = Array.isArray(mock.calls) ? mock.calls : [];
    if (calls.some((call: { method: string; path: string }) => `${call.method} ${call.path}` === expected)) {
      return;
    }
    await wait(25);
  }
  throw new Error(`Timed out waiting for mock call: ${expected}`);
}

function tempState() {
  // Each test gets its own iMessage Handoff state directory. That keeps the
  // install/start/stop files isolated and makes failures easier to reason about.
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "http://127.0.0.1:9",
    token: "dev-token",
  }));
  return stateDir;
}

function shellQuoteForTest(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function mockFile(responses: Record<string, unknown>) {
  // The scripts know how to read this file instead of making real HTTP calls.
  // They append every request they would have sent, which lets assertions check
  // both the response handling and the outbound payload.
  const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-mock-")), "mock.json");
  writeFileSync(filePath, JSON.stringify({ responses, calls: [] }));
  return filePath;
}

function makePng(name: string, content: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-image-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, Buffer.from(content));
  return filePath;
}

function makeSessionLog(rows: unknown[]) {
  const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-session-")), "session.jsonl");
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return filePath;
}

function makeGlobalState(queuedFollowUps: Record<string, unknown[]>) {
  const filePath = path.join(mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-global-state-")), "global-state.json");
  writeFileSync(filePath, JSON.stringify({
    "queued-follow-ups": queuedFollowUps,
  }));
  return filePath;
}

async function withInstallRelay<T>(callback: (url: string) => Promise<T>) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ token: "relay-token" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(url);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function makeCodexStateDb(rows: Array<{ id: string; title: string }>) {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-state-db-")), "state_5.sqlite");
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

test("imessage-handoff uninstall removes only the iMessage Handoff Stop hook", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));
  const hooksPath = path.join(codexHome, "hooks.json");
  writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: "'node' '/tmp/imessage-handoff/scripts/publish-stop.js'", timeout: 1 },
            { type: "command", command: "'node' '/tmp/other-tool/scripts/publish-stop.js'", timeout: 2 },
            { type: "command", command: "echo keep-stop-hook" },
          ],
        },
        {
          hooks: [
            { type: "command", command: "echo keep-other-group" },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            { type: "command", command: "echo keep-notification-hook" },
          ],
        },
      ],
    },
  }));

  const result = runCli(["uninstall", "--codex-home=" + codexHome]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hooksRemoved, 1);

  const hooksRoot = JSON.parse(readFileSync(hooksPath, "utf8"));
  const stopCommands = hooksRoot.hooks.Stop.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map((hook) => hook.command));
  assert.deepEqual(stopCommands, ["'node' '/tmp/other-tool/scripts/publish-stop.js'", "echo keep-stop-hook", "echo keep-other-group"]);
  assert.equal(hooksRoot.hooks.Notification[0].hooks[0].command, "echo keep-notification-hook");
});

test("imessage-handoff uninstall removes empty Stop groups", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));
  const hooksPath = path.join(codexHome, "hooks.json");
  writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: "'node' '/tmp/imessage-handoff/scripts/publish-stop.js'" },
          ],
        },
      ],
    },
  }));

  const result = runCli(["uninstall", "--codex-home=" + codexHome]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hooksRemoved, 1);

  const hooksRoot = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.equal("Stop" in hooksRoot.hooks, false);
});

test("imessage-handoff install copies the skill without creating relay config or hooks", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));
  const result = runCli(["install", "--codex-home=" + codexHome]);
  assert.equal(result.status, 0, result.stderr);

  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.configured, false);
  assert.equal(output.hookInstalled, false);
  assert.equal(existsSync(path.join(codexHome, "skills", "imessage-handoff", "SKILL.md")), true);
  assert.equal(existsSync(path.join(codexHome, "skills", "imessage-handoff", ".state", "config.json")), false);
  assert.equal(existsSync(path.join(codexHome, "hooks.json")), false);
});

test("configure sets a self-hosted relay and redacts config output", async () => {
  await withInstallRelay(async (relayUrl) => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-config-"));
    const result = await runScript("configure.js", ["set-relay", "--url=" + relayUrl], { stateDir });
    assert.equal(result.code, 0, result.stderr);

    const config = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
    assert.equal(config.apiBaseUrl, relayUrl);
    assert.equal(config.token, "relay-token");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.config.apiBaseUrl, relayUrl);
    assert.equal(output.config.token, "<redacted>");

    const show = await runScript("configure.js", ["show"], { stateDir });
    assert.equal(show.code, 0, show.stderr);
    const showOutput = JSON.parse(show.stdout);
    assert.equal(showOutput.configured, true);
    assert.equal(showOutput.config.token, "<redacted>");
  });
});

test("configure use-default-relay creates hosted relay config", async () => {
  await withInstallRelay(async (relayUrl) => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-config-"));
    const result = await runScript("configure.js", ["use-default-relay"], { stateDir, relayUrl });
    assert.equal(result.code, 0, result.stderr);

    const config = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
    assert.equal(config.apiBaseUrl, relayUrl);
    assert.equal(config.token, "relay-token");
    assert.equal(config.stopWaitSeconds, 86400);

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.tokenCreated, true);
    assert.equal(output.config.apiBaseUrl, relayUrl);
    assert.equal(output.config.token, "<redacted>");
  });
});

test("configure reset-token replaces the local token", async () => {
  await withInstallRelay(async (relayUrl) => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-config-"));
    writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
      apiBaseUrl: relayUrl,
      token: "old-token",
      stopWaitSeconds: 123,
    }));

    const result = await runScript("configure.js", ["reset-token"], { stateDir });
    assert.equal(result.code, 0, result.stderr);

    const config = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
    assert.equal(config.apiBaseUrl, relayUrl);
    assert.equal(config.token, "relay-token");
    assert.equal(config.stopWaitSeconds, 123);
    assert.equal(JSON.parse(result.stdout).tokenCreated, true);
  });
});

test("configure install-hook installs once and reports ready status", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-config-"));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));

  const before = await runScript("configure.js", ["hook-status"], { stateDir, codexHome });
  assert.equal(before.code, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).ready, false);

  const install = await runScript("configure.js", ["install-hook"], { stateDir, codexHome });
  assert.equal(install.code, 0, install.stderr);
  const installOutput = JSON.parse(install.stdout);
  assert.equal(installOutput.hookSetupChanged, true);
  assert.equal(installOutput.codexHooksEnabled, true);
  assert.equal(installOutput.stopHookInstalled, true);
  assert.equal(installOutput.ready, true);

  const secondInstall = await runScript("configure.js", ["install-hook"], { stateDir, codexHome });
  assert.equal(secondInstall.code, 0, secondInstall.stderr);
  const secondOutput = JSON.parse(secondInstall.stdout);
  assert.equal(secondOutput.hookSetupChanged, false);
  assert.equal(secondOutput.ready, true);
});

test("configure hook-status accepts an existing iMessage Handoff hook with a different node path", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-config-"));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));
  const hooksPath = path.join(codexHome, "hooks.json");
  const existingCommand = "'/usr/local/bin/node' '/Users/gabe/.codex/skills/imessage-handoff/scripts/publish-stop.js'";
  writeFileSync(path.join(codexHome, "config.toml"), "[features]\ncodex_hooks = true\n");
  writeFileSync(hooksPath, JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [{
          type: "command",
          command: existingCommand,
          timeout: 86520,
          statusMessage: "Waiting for iMessage replies",
          silent: true,
        }],
      }],
    },
  }));

  const status = await runScript("configure.js", ["hook-status"], { stateDir, codexHome });
  assert.equal(status.code, 0, status.stderr);
  const output = JSON.parse(status.stdout);
  assert.equal(output.codexHooksEnabled, true);
  assert.equal(output.stopHookInstalled, true);
  assert.equal(output.ready, true);

  const install = await runScript("configure.js", ["install-hook"], { stateDir, codexHome });
  assert.equal(install.code, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).hookSetupChanged, false);
  const hooksRoot = JSON.parse(readFileSync(hooksPath, "utf8"));
  assert.equal(hooksRoot.hooks.Stop[0].hooks[0].command, existingCommand);
});

test("publish-stop exits quietly for inactive threads", async () => {
  const stateDir = tempState();
  const result = await runScript("publish-stop.js", [], {
    stateDir,
    stdin: JSON.stringify({ session_id: "session-1", cwd: "/tmp/project" }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("start-handoff requires CODEX_THREAD_ID", async () => {
  const stateDir = tempState();
  const result = await runScript("start-handoff.js", [], { stateDir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CODEX_THREAD_ID is required/);
});

test("start-handoff requires relay config before installing the Stop hook", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: false,
        pairingRequired: true,
        pairingCode: "ABC123",
        skipNextStatusSend: false,
      },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));

  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project"], {
    stateDir,
    codexHome,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Choose the hosted relay or provide your self-hosted relay URL/);
  assert.equal(existsSync(path.join(stateDir, "config.json")), false);
  assert.equal(existsSync(path.join(codexHome, "hooks.json")), false);

  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls.length, 0);
});

test("start-handoff creates thread and writes active registry", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: false,
        pairingRequired: true,
        pairingCode: "ABC123",
        skipNextStatusSend: false,
      },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));

  const result = await runScript("start-handoff.js", [
    "--cwd=/tmp/project",
    "--handoff-summary=You were deciding what to prototype next.",
  ], { stateDir, codexHome, mockFile: mockPath, codexThreadId: "codex-thread-1" });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.codexThreadId, "codex-thread-1");
  assert.equal(parsed.sendblueNumber, "+12344198201");
  assert.equal(parsed.sendblueNumberDisplay, "+1 (234) 419-8201");
  assert.equal(parsed.paired, false);
  assert.equal(parsed.pairingRequired, true);
  assert.equal(parsed.pairingCode, "ABC123");
  assert.equal(parsed.localMessage, "iMessage Handoff is enabled. Text `ABC123` to `+1 (234) 419-8201` within 15 minutes to continue this thread from iMessage.");
  assert.match(parsed.statusCurlCommand, /curl -sS/);
  assert.match(parsed.statusCurlCommand, /\/threads\/codex-thread-1/);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].cwd, "/tmp/project");
  assert.equal(active.threads["codex-thread-1"].lastStopAt, null);
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, false);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].method, "POST");
  assert.equal(mock.calls[0].path, "/threads/codex-thread-1");
  assert.equal(mock.calls[0].authorization, "Bearer <redacted>");
  assert.equal("userId" in mock.calls[0].body, false);
  assert.equal(mock.calls[0].body.cwd, "/tmp/project");
  assert.equal("title" in mock.calls[0].body, false);
  assert.equal(mock.calls[0].body.handoffSummary, "You were deciding what to prototype next.");

  assert.equal(existsSync(path.join(codexHome, "hooks.json")), false);
});

test("start-handoff omits restart hint when hook setup is unchanged", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: false,
        pairingRequired: true,
        pairingCode: "ABC123",
        skipNextStatusSend: false,
      },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-codex-home-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(codexHome, "config.toml"), "[features]\ncodex_hooks = true\n");
  writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({
    hooks: {
      Stop: [{
        hooks: [{
          type: "command",
          command: [
            shellQuoteForTest(process.execPath),
            shellQuoteForTest(path.resolve("imessage-handoff/scripts/publish-stop.js")),
          ].join(" "),
          timeout: 86520,
          statusMessage: "Waiting for iMessage replies",
          silent: true,
        }],
      }],
    },
  }));

  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project"], {
    stateDir,
    codexHome,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.localMessage, "iMessage Handoff is enabled. Text `ABC123` to `+1 (234) 419-8201` within 15 minutes to continue this thread from iMessage.");
});

test("start-handoff uses the Codex sidebar title from the local state db", async () => {
  const stateDb = makeCodexStateDb([
    { id: "codex-thread-1", title: "Create iMessage Handoff app" },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
    stateDb,
  });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.localMessage, "iMessage Handoff is enabled. Text `+1 (234) 419-8201` to talk to Codex.");
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, true);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.title, "Create iMessage Handoff app");
  assert.equal("handoffSummary" in mock.calls[0].body, false);
});

test("start-handoff sends normalized skill-link titles", async () => {
  const stateDb = makeCodexStateDb([
    { id: "codex-thread-1", title: "[$imessage-handoff](/Users/gabe/.codex/skills/imessage-handoff/SKILL.md)" },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
    stateDb,
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.title, "$imessage-handoff");
});

test("start-handoff allows activation-only titles", async () => {
  const stateDb = makeCodexStateDb([
    { id: "codex-thread-1", title: "Start iMessage handoff" },
  ]);
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project"], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
    stateDb,
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.title, "Start iMessage handoff");
});

test("start-handoff omits empty handoff summaries", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
        paired: true,
        pairingRequired: false,
        pairingCode: null,
        skipNextStatusSend: true,
      },
    },
  });
  const stateDir = tempState();

  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project", "--handoff-summary=   "], {
    stateDir,
    mockFile: mockPath,
    codexThreadId: "codex-thread-1",
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal("handoffSummary" in mock.calls[0].body, false);
});

test("start-handoff resets local activation time when re-enabling a thread", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1": {
      body: {
        id: "codex-thread-1",
        sendblueNumber: "+12344198201",
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
  const result = await runScript("start-handoff.js", ["--cwd=/tmp/project"], {
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

test("publish-stop exits quietly after status when no iMessage reply is pending", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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
  ]);
  assert.deepEqual(mock.websocketCalls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "WS /threads/codex-thread-1/events",
  ]);
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
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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
  ]);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(Boolean(active.threads["codex-thread-1"]), true);
});

test("publish-stop disables handoff and blocks with a local takeover note", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "POST /threads/codex-thread-1/stop": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  const globalState = makeGlobalState({});
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 3,
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

  await waitForMockCall(mockPath, "POST /threads/codex-thread-1/status");
  writeFileSync(globalState, JSON.stringify({
    "queued-follow-ups": {
      "codex-thread-1": [{ id: "follow-up-1", text: "local message" }],
    },
  }));
  await wait(600);
  writeFileSync(globalState, JSON.stringify({ "queued-follow-ups": {} }));

  assert.equal((await closed), 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /iMessage Handoff was active/);
  assert.match(parsed.reason, /turn off iMessage Handoff since you're back here in Codex/);
  assert.match(parsed.reason, /continue normally with the user's local message/);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  const calls = mock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`);
  assert.ok(calls.includes("POST /threads/codex-thread-1/status"));
  assert.equal(calls.filter((call: string) => call === "POST /threads/codex-thread-1/stop").length, 1);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.deepEqual(active.threads, {});
});

test("publish-stop claims an iMessage reply and emits a block decision", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: { ok: true, reply: { id: "reply_1", body: "What is 2 + 2?" } },
    },
  });
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [{ type: "reply-pending", replyId: "reply_1" }],
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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
  assert.match(parsed.reason, /Local display block to render:\n\*\*iMessage reply\*\*\n> What is 2 \+ 2\?/);
  assert.match(parsed.reason, /send-update\.js' --thread-id='codex-thread-1' --message='Brief progress update here'/);
  assert.match(parsed.reason, /very brief progress update every few minutes/);
  assert.match(parsed.reason, /Start your assistant response with the local display block/);
  assert.match(parsed.reason, /User message to answer:\nWhat is 2 \+ 2\?/);
  assert.doesNotMatch(parsed.reason, /empty response/);
  assert.doesNotMatch(parsed.reason, /connectivity test/);
  assert.doesNotMatch(parsed.reason, /claimed reply/i);
  const updatedMock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(updatedMock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/status",
    "POST /threads/codex-thread-1/replies/reply_1/claim",
  ]);
  assert.equal(updatedMock.calls[1].body, null);
});

test("send-update publishes a working status without exposing auth", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": {
      body: { ok: true, notification: { sent: true, status: "QUEUED", messageHandle: "message-1" } },
    },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
  }));

  const result = await runScript("send-update.js", [
    "--thread-id=codex-thread-1",
    "--message=Still working through the implementation and tests.",
  ], { stateDir, mockFile: mockPath });
  assert.equal(result.code, 0, result.stderr);

  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.notification.messageHandle, "message-1");

  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].authorization, "Bearer <redacted>");
  assert.deepEqual(mock.calls[0].body, {
    cwd: path.resolve("."),
    lastAssistantMessage: "Still working through the implementation and tests.",
    status: "working",
    createdAt: mock.calls[0].body.createdAt,
  });
  assert.match(mock.calls[0].body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("publish-stop claims websocket replies by id", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: { ok: true, reply: { id: "reply_1", body: "Use websocket mode" } },
    },
  });
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [{ type: "reply-pending", replyId: "reply_1" }],
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /Use websocket mode/);
  const updatedMock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(updatedMock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/status",
    "POST /threads/codex-thread-1/replies/reply_1/claim",
  ]);
  assert.deepEqual(updatedMock.websocketCalls.map((call: { method: string; path: string; body: { type: string } }) => ({
    method: call.method,
    path: call.path,
    type: call.body.type,
  })), [{
    method: "WS",
    path: "/threads/codex-thread-1/events",
    type: "stop-hook-connected",
  }]);
});

test("publish-stop reconnects when websocket closes before a reply", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: { ok: true, reply: { id: "reply_1", body: "Reconnect still waits" } },
    },
  });
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [null, { type: "reply-pending", replyId: "reply_1" }],
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 5,
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
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /Reconnect still waits/);
  const updatedMock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.deepEqual(updatedMock.calls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "POST /threads/codex-thread-1/status",
    "POST /threads/codex-thread-1/replies/reply_1/claim",
  ]);
  assert.deepEqual(updatedMock.websocketCalls.map((call: { method: string; path: string }) => `${call.method} ${call.path}`), [
    "WS /threads/codex-thread-1/events",
    "WS /threads/codex-thread-1/events",
  ]);
});

test("publish-stop formats multi-line iMessage replies including blank lines", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "POST /threads/codex-thread-1/replies/reply_1/claim": {
      body: { ok: true, reply: { id: "reply_1", body: "First line\n\nThird line" } },
    },
  });
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [{ type: "reply-pending", replyId: "reply_1" }],
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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
  assert.match(parsed.reason, /\*\*iMessage reply\*\*\n> First line\n>  \n> Third line/);
  assert.match(parsed.reason, /User message to answer:\nFirst line\n\nThird line/);
});

test("publish-stop downloads one iMessage image and includes the local path", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
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
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [{ type: "reply-pending", replyId: "reply_1" }],
  };
  mock.mediaResponses = {
    "https://cdn.example.test/cow.jpg": {
      contentType: "image/jpeg",
      dataBase64: Buffer.from("cow-bytes").toString("base64"),
    },
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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

test("publish-stop downloads multiple iMessage images in order", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
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
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [{ type: "reply-pending", replyId: "reply_group" }],
  };
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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

test("publish-stop reports a clear error when iMessage image download fails", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
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
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  mock.websocketEvents = {
    "/threads/codex-thread-1/events": [{ type: "reply-pending", replyId: "reply_1" }],
  };
  writeFileSync(mockPath, JSON.stringify(mock));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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

test("publish-stop exits without waiting when active entry is missing", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 0,
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

test("publish-stop exits during websocket wait after stop-handoff removes the active entry", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
    "POST /threads/codex-thread-1/stop": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    apiBaseUrl: "https://example.test",
    token: "dev-token",
    stopWaitSeconds: 3,
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
  const stop = await runScript("stop-handoff.js", [], { stateDir, mockFile: mockPath, codexThreadId: "codex-thread-1" });
  assert.equal(stop.code, 0);
  assert.equal((await closed), 0);
  assert.equal(stdout, "");
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"], undefined);
});

test("stop-handoff removes the current codex thread", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/stop": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token" }));
  writeFileSync(path.join(stateDir, "active-threads.json"), JSON.stringify({
    threads: {
      "codex-thread-1": { cwd: "/tmp/project", createdAt: "2026-04-25T18:20:00.000Z", lastStopAt: null },
      "codex-thread-2": { cwd: "/tmp/project", createdAt: "2026-04-25T18:21:00.000Z", lastStopAt: null },
    },
  }));

  const result = await runScript("stop-handoff.js", [], { stateDir, mockFile: mockPath, codexThreadId: "codex-thread-1" });
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

test("stop-handoff requires a codex thread id", async () => {
  const stateDir = tempState();
  const result = await runScript("stop-handoff.js", [], { stateDir });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CODEX_THREAD_ID is required/);
});

test("publish-stop stores empty assistant messages as null", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
      last_assistant_message: "Done. I created imessage-test.txt.",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, "Done. I created imessage-test.txt.");
});

test("publish-stop skips the local start-handoff activation status once", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
      last_assistant_message: "iMessage Handoff is enabled. Text `+1 (234) 419-8201` to talk to Codex.",
    }),
  });
  assert.equal(result.code, 0);
  const mock = JSON.parse(readFileSync(mockPath, "utf8"));
  assert.equal(mock.calls[0].body.lastAssistantMessage, null);
  const active = JSON.parse(readFileSync(path.join(stateDir, "active-threads.json"), "utf8"));
  assert.equal(active.threads["codex-thread-1"].skipNextStatusSend, false);
});

test("publish-stop strips local-only iMessage reply blocks before publishing status", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
        "**iMessage reply**",
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

test("publish-stop strips local-only iMessage reply blocks when the header is quoted", async () => {
  const mockPath = mockFile({
    "POST /threads/codex-thread-1/status": { body: { ok: true } },
  });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
        "> **iMessage reply**",
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
        "**iMessage reply**",
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "imessage-handoff-test-"));
  writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ apiBaseUrl: "https://example.test", token: "dev-token", stopWaitSeconds: 0 }));
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
