#!/usr/bin/env node
const { apiFetch, readConfig } = require("./common.js");

// Called manually by Codex during longer remote tasks to reassure the iMessage
// user that work is still moving. It uses the same status endpoint as the Stop
// hook, but marks the thread as "working" instead of "stopped".

function readArg(name) {
  const prefix = "--" + name + "=";
  const match = process.argv.find(function findArg(arg) {
    return arg.indexOf(prefix) === 0;
  });
  return match ? match.slice(prefix.length) : "";
}

async function main() {
  const threadId = readArg("thread-id") || process.env.CODEX_THREAD_ID || "";
  const message = readArg("message").trim();
  if (!threadId.trim()) {
    throw new Error("A Codex thread id is required.");
  }
  if (!message) {
    throw new Error("A progress update message is required.");
  }

  const config = readConfig();
  const result = await apiFetch(config, "/threads/" + encodeURIComponent(threadId.trim()) + "/status", {
    method: "POST",
    body: JSON.stringify({
      cwd: process.cwd(),
      lastAssistantMessage: message,
      status: "working",
      createdAt: new Date().toISOString(),
    }),
  });

  console.log(JSON.stringify({
    ok: true,
    notification: result.notification || null,
  }, null, 2));
}

main().catch(function onError(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
