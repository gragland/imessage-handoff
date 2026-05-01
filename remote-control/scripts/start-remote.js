#!/usr/bin/env node
const { apiFetch, configPath, discoverThreadTitle, ensureLocalInstall, shellQuote, readActiveThreads, writeActiveThreads } = require("./common.js");

// start-remote is run by the Codex skill when the user wants this thread to be
// reachable from iMessage. It registers the thread with the relay and records
// local state so the global Stop hook knows to wait for remote replies.

function readArg(name) {
  const prefix = "--" + name + "=";
  const match = process.argv.find(function findArg(arg) {
    return arg.indexOf(prefix) === 0;
  });
  return match ? match.slice(prefix.length) : "";
}

function configReadCommand(field) {
  // The debug curl command reads config at execution time, so it still works if
  // the user resets their token after this script printed the command.
  return "node -p " + shellQuote("JSON.parse(require(\"fs\").readFileSync(" + JSON.stringify(configPath) + ", \"utf8\"))." + field);
}

function formatPhoneNumber(value) {
  const text = String(value || "");
  const digits = text.replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "1") {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return text;
}

function normalizeHandoffSummary(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function main() {
  const codexThreadId = process.env.CODEX_THREAD_ID ? process.env.CODEX_THREAD_ID.trim() : "";
  if (!codexThreadId) {
    console.error("CODEX_THREAD_ID is required. Run start remote from inside a Codex thread.");
    process.exit(2);
  }
  const config = await ensureLocalInstall();

  const cwd = readArg("cwd") || process.cwd();
  const title = discoverThreadTitle(codexThreadId, cwd);
  const handoffSummary = normalizeHandoffSummary(readArg("handoff-summary"));
  // Keep registration metadata light: enough for routing and a friendly thread
  // list, but no conversation history.
  const registrationBody = {
    cwd,
  };
  if (title) {
    registrationBody.title = title;
  }
  if (handoffSummary) {
    registrationBody.handoffSummary = handoffSummary;
  }
  const registrationResult = await apiFetch(config, "/threads/" + encodeURIComponent(codexThreadId), {
    method: "POST",
    body: JSON.stringify(registrationBody),
  });

  const active = readActiveThreads();
  const startedAt = new Date().toISOString();
  // This local active entry is what makes publish-stop wait after future local
  // assistant turns in this Codex thread.
  active.threads[codexThreadId] = {
    ...(active.threads[codexThreadId] || {}),
    cwd,
    createdAt: startedAt,
    lastStopAt: null,
  };
  active.threads[codexThreadId].skipNextStatusSend = Boolean(registrationResult.skipNextStatusSend);
  writeActiveThreads(active);

  const encodedThreadId = encodeURIComponent(codexThreadId);
  const authHeader = "\"Authorization: Bearer $(" + configReadCommand("token") + ")\"";
  const apiBaseUrl = "$(" + configReadCommand("apiBaseUrl") + ")";
  const statusCurlCommand = [
    "curl -sS",
    "-H " + authHeader,
    "\"" + apiBaseUrl + "/threads/" + encodedThreadId + "\"",
  ].join(" ");

  const sendblueNumberDisplay = formatPhoneNumber(registrationResult.sendblueNumber);
  const localMessage = registrationResult.pairingRequired
    // First install: user must text this code once so the relay can bind phone
    // number -> local install token owner.
    ? `Remote control is enabled. Text \`${registrationResult.pairingCode}\` to \`${sendblueNumberDisplay}\` to continue this thread from iMessage.`
    // Already paired: starting remote switches the paired phone to this thread.
    : `Remote control is enabled. Text \`${sendblueNumberDisplay}\` to talk to Codex.`;

  console.log(JSON.stringify({
    ok: true,
    codexThreadId,
    sendblueNumber: registrationResult.sendblueNumber,
    sendblueNumberDisplay,
    paired: registrationResult.paired,
    pairingRequired: registrationResult.pairingRequired,
    pairingCode: registrationResult.pairingCode,
    localMessage,
    statusCurlCommand,
  }, null, 2));
}

main().catch(function onError(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
