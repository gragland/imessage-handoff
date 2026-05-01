#!/usr/bin/env node
const { apiFetch, readActiveThreads, readConfig, writeActiveThreads } = require("./common.js");

// stop-remote turns off remote continuation for the current local Codex thread.
// It updates both the hosted relay and local active-thread state, but local state
// wins if the network is temporarily unavailable.

async function main() {
  const codexThreadId = process.env.CODEX_THREAD_ID ? process.env.CODEX_THREAD_ID.trim() : "";
  if (!codexThreadId) {
    console.error("CODEX_THREAD_ID is required. Run stop remote from inside a Codex thread.");
    process.exit(2);
  }

  const active = readActiveThreads();
  const removedThreadIds = [];
  let serverStopped = false;
  let serverError = null;

  try {
    const config = readConfig();
    // Tell the relay this thread should no longer receive iMessage prompts.
    await apiFetch(config, `/threads/${encodeURIComponent(codexThreadId)}/stop`, { method: "POST" });
    serverStopped = true;
  } catch (error) {
    serverError = error instanceof Error ? error.message : String(error);
  }

  if (active.threads[codexThreadId]) {
    // Remove local state so any currently running Stop hook exits quietly.
    delete active.threads[codexThreadId];
    removedThreadIds.push(codexThreadId);
  }

  writeActiveThreads(active);
  console.log(JSON.stringify({
    ok: true,
    removedCount: removedThreadIds.length,
    codexThreadIds: removedThreadIds,
    serverStopped,
    serverError,
  }, null, 2));
}

main().catch(function onError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
