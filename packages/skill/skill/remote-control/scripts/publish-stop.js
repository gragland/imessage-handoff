#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { apiFetch, readActiveThreads, readConfig, stateDir, writeActiveThreads } = require("./common.js");

const LOCAL_ONLY_START = "**Remote message**";
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WEBSOCKET_RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 5000];

// publish-stop is the global Codex Stop hook. After each assistant response it:
// 1. publishes the assistant result to Sendblue,
// 2. waits for a remote iMessage reply, and
// 3. blocks the next Codex turn with that reply as if the user typed it locally.

async function readStdinJson() {
  return new Promise(function readStdin(resolve, reject) {
    const chunks = [];
    process.stdin.on("data", function onData(chunk) {
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", function onEnd() {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sanitizeAssistantMessage(value) {
  // Codex's previous response may include the local-only display block from a
  // remote prompt. Strip that before sending the assistant answer back to iMessage.
  if (typeof value !== "string") {
    return null;
  }

  const text = value
    .replace(/^(?:>\s*)?(?:🟢\s*)?(?:\*\*Remote message\*\*|Remote message:)\s*\n(?:>.*(?:\n|$))*\s*/gm, "")
    .trim();
  return text || null;
}

function quoteRemoteLine(line, index) {
  const body = line || "\u00a0";
  return `> ${body}`;
}

function safePathSegment(value) {
  return String(value || "reply")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120) || "reply";
}

function extensionForMedia(url, contentType) {
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (normalizedType === "image/jpeg" || normalizedType === "image/jpg") {
    return ".jpg";
  }
  if (normalizedType === "image/png") {
    return ".png";
  }
  if (normalizedType === "image/gif") {
    return ".gif";
  }
  if (normalizedType === "image/webp") {
    return ".webp";
  }
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
  } catch {
    // Fall through to the generic image extension.
  }
  return ".img";
}

async function downloadBinary(url) {
  if (process.env.REMOTE_CONTROL_MOCK_FILE) {
    const mock = JSON.parse(readFileSync(process.env.REMOTE_CONTROL_MOCK_FILE, "utf8"));
    const media = mock.mediaResponses && mock.mediaResponses[url];
    if (!media) {
      throw new Error("No mock media response for " + url);
    }
    return {
      bytes: Buffer.from(String(media.dataBase64 || ""), "base64"),
      contentType: media.contentType || "application/octet-stream",
    };
  }

  if (typeof fetch === "function") {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Attachment download failed with " + response.status);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  }

  return new Promise(function requestPromise(resolve, reject) {
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.request(parsed, function onResponse(response) {
      const chunks = [];
      response.on("data", function onData(chunk) {
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", function onEnd() {
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          reject(new Error("Attachment download failed with " + response.statusCode));
          return;
        }
        resolve({
          bytes: Buffer.concat(chunks),
          contentType: response.headers["content-type"] || "application/octet-stream",
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function downloadReplyMedia(codexThreadId, reply) {
  // The relay passes media URLs. The local hook downloads them into skill state
  // so Codex can inspect local files instead of remote URLs.
  const media = Array.isArray(reply.media) ? reply.media : [];
  if (media.length === 0) {
    return [];
  }

  const attachmentDir = path.join(
    stateDir,
    "attachments",
    safePathSegment(codexThreadId),
    safePathSegment(reply.id),
  );
  mkdirSync(attachmentDir, { recursive: true });

  const downloaded = [];
  for (let index = 0; index < media.length; index += 1) {
    const item = media[index];
    const url = item && typeof item.url === "string" ? item.url : "";
    if (!url) {
      continue;
    }
    const file = await downloadBinary(url);
    const filePath = path.join(attachmentDir, `image-${index + 1}${extensionForMedia(url, file.contentType)}`);
    writeFileSync(filePath, file.bytes);
    downloaded.push(filePath);
  }
  return downloaded;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function threadEventsUrl(config, codexThreadId) {
  // The relay URL is HTTP(S), but the events endpoint is WebSocket.
  const url = new URL(config.apiBaseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/threads/${encodeURIComponent(codexThreadId)}/events`;
  url.search = "";
  url.searchParams.set("token", config.token);
  return url.toString();
}

function readMockWebSocketEvent(config, codexThreadId, payload) {
  // Unit tests simulate WebSocket events through the same mock file used for
  // HTTP calls. Production never enters this branch.
  if (!process.env.REMOTE_CONTROL_MOCK_FILE) {
    return undefined;
  }

  const mockPath = process.env.REMOTE_CONTROL_MOCK_FILE;
  const mock = existsSync(mockPath) ? JSON.parse(readFileSync(mockPath, "utf8")) : {};
  const pathName = `/threads/${codexThreadId}/events`;
  mock.websocketCalls = Array.isArray(mock.websocketCalls) ? mock.websocketCalls : [];
  mock.websocketCalls.push({
    method: "WS",
    path: pathName,
    authorization: "Bearer " + config.token,
    body: payload,
  });
  const events = mock.websocketEvents && mock.websocketEvents[pathName];
  const event = Array.isArray(events) ? events.shift() : events;
  writeFileSync(mockPath, JSON.stringify(mock, null, 2) + "\n", "utf8");
  return event || null;
}

function startWebSocketWait(config, codexThreadId) {
  // WebSocket mode waits for the Durable Object to say a reply is pending, then
  // claims that reply through the normal HTTP claim endpoint.
  const payload = {
    type: "stop-hook-connected",
    threadId: codexThreadId,
    sentAt: new Date().toISOString(),
  };

  const mockEvent = readMockWebSocketEvent(config, codexThreadId, payload);
  if (mockEvent !== undefined) {
    return {
      replyId: Promise.resolve(mockEvent && mockEvent.replyId ? String(mockEvent.replyId) : null),
      close: function closeMockSocket() {},
    };
  }
  if (typeof WebSocket !== "function") {
    return null;
  }

  try {
    let settled = false;
    let resolveReplyId;
    const socket = new WebSocket(threadEventsUrl(config, codexThreadId));
    const replyId = new Promise(function waitForReply(resolve) {
      resolveReplyId = resolve;
    });
    function resolveOnce(value) {
      if (!settled) {
        settled = true;
        resolveReplyId(value);
      }
    }
    socket.addEventListener("open", function onOpen() {
      socket.send(JSON.stringify(payload));
    });
    socket.addEventListener("message", function onMessage(event) {
      try {
        const message = JSON.parse(String(event.data || "{}"));
        if (message && message.type === "reply-pending" && message.replyId) {
          resolveOnce(String(message.replyId));
        }
      } catch {
        // Ignore malformed socket messages.
      }
    });
    socket.addEventListener("error", function onError() {
      resolveOnce(null);
    });
    socket.addEventListener("close", function onClose() {
      resolveOnce(null);
    });
    return {
      replyId,
      close: function closeProbe() {
        if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
          socket.close(1000, "stop hook finished");
        }
        resolveOnce(null);
      },
    };
  } catch {
    return null;
  }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function globalStatePath() {
  return process.env.REMOTE_CONTROL_GLOBAL_STATE_PATH || path.join(codexHome(), ".codex-global-state.json");
}

function hasQueuedLocalFollowUp(codexThreadId) {
  // If the user typed locally while the Stop hook was waiting remotely, local
  // input should take over and remote control should stop for this thread.
  try {
    const raw = readFileSync(globalStatePath(), "utf8");
    const state = JSON.parse(raw);
    const queued = state && state["queued-follow-ups"];
    const threadQueue = queued && queued[codexThreadId];
    return Array.isArray(threadQueue) && threadQueue.length > 0;
  } catch {
    return false;
  }
}

function findSessionLog(codexThreadId, thread) {
  // Generated images are recorded in Codex session logs. Find the current log so
  // the hook can forward newly generated images to iMessage.
  if (process.env.REMOTE_CONTROL_SESSION_LOG) {
    return process.env.REMOTE_CONTROL_SESSION_LOG;
  }
  if (thread.sessionLogPath && existsSync(thread.sessionLogPath)) {
    return thread.sessionLogPath;
  }

  const roots = [
    path.join(codexHome(), "sessions"),
    path.join(codexHome(), "archived_sessions"),
  ];
  for (const root of roots) {
    const found = findFileContaining(root, `${codexThreadId}.jsonl`);
    if (found) {
      return found;
    }
  }
  return null;
}

function findFileContaining(root, needle) {
  if (!existsSync(root)) {
    return null;
  }
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.includes(needle)) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const found = findFileContaining(entryPath, needle);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function readSessionRows(sessionLogPath) {
  if (!sessionLogPath || !existsSync(sessionLogPath)) {
    return [];
  }
  return readFileSync(sessionLogPath, "utf8")
    .split(/\n/)
    .flatMap(function parseLine(line) {
      if (!line.trim()) {
        return [];
      }
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readGeneratedImages(codexThreadId, thread) {
  // Scan only images created after the last successful stop publish. Each image
  // event id is tracked so retries do not resend already delivered images.
  const sessionLogPath = findSessionLog(codexThreadId, thread);
  if (!sessionLogPath || !existsSync(sessionLogPath)) {
    return { sessionLogPath: null, images: [] };
  }

  const sent = new Set(Array.isArray(thread.sentGeneratedImageEvents) ? thread.sentGeneratedImageEvents : []);
  const cursor = Date.parse(thread.lastGeneratedImageScanAt || thread.lastStopAt || thread.createdAt || "1970-01-01T00:00:00.000Z");
  const rows = readSessionRows(sessionLogPath);
  const images = [];

  for (const row of rows) {
    const payload = row && row.payload;
    if (!row || row.type !== "event_msg" || !payload || payload.type !== "image_generation_end") {
      continue;
    }
    const eventTime = Date.parse(row.timestamp || "");
    if (Number.isFinite(cursor) && Number.isFinite(eventTime) && eventTime <= cursor) {
      continue;
    }
    const savedPath = typeof payload.saved_path === "string" ? payload.saved_path : "";
    if (!savedPath || !existsSync(savedPath)) {
      continue;
    }
    const eventId = typeof payload.call_id === "string" ? payload.call_id : savedPath;
    if (sent.has(eventId)) {
      continue;
    }
    const bytes = readFileSync(savedPath);
    images.push({
      eventId,
      path: savedPath,
      filename: path.basename(savedPath),
      mimeType: "image/png",
      dataBase64: bytes.toString("base64"),
    });
  }

  return { sessionLogPath, images };
}

async function claimReplyById(config, codexThreadId, replyId) {
  // Claiming is the moment the relay hands a remote prompt to local Codex and
  // scrubs it from the relay buffer.
  const encodedThreadId = encodeURIComponent(codexThreadId);
  const claimed = await apiFetch(
    config,
    `/threads/${encodedThreadId}/replies/${encodeURIComponent(replyId)}/claim`,
    { method: "POST" },
  );

  return claimed.ok && claimed.reply ? claimed.reply : null;
}

async function stopRemoteThread(config, codexThreadId) {
  try {
    await apiFetch(config, `/threads/${encodeURIComponent(codexThreadId)}/stop`, { method: "POST" });
  } catch {
    // Local takeover should still release Codex even if the remote status call is temporarily unavailable.
  }
}

async function disableRemoteSilently(config, codexThreadId, active) {
  await stopRemoteThread(config, codexThreadId);
  delete active.threads[codexThreadId];
  writeActiveThreads(active);
}

async function disableRemoteForLocalTakeover(config, codexThreadId, active) {
  await disableRemoteSilently(config, codexThreadId, active);
  return { localTakeover: true };
}

async function waitForReplyWhileActive(config, codexThreadId) {
  return waitForReplyByWebSocket(config, codexThreadId);
}

async function waitForReplyByWebSocket(config, codexThreadId) {
  // Keep a socket open during the Stop hook wait. A
  // reply-pending event wakes the hook without repeated HTTP requests. If the
  // connection drops before a reply arrives, retry with bounded backoff.
  const deadline = Date.now() + Math.max(0, config.stopWaitSeconds) * 1000;
  const localFollowUpCheckMs = 250;

  for (let attempt = 0; attempt === 0 || Date.now() < deadline; attempt += 1) {
    const active = readActiveThreads();
    if (!active.threads[codexThreadId]) {
      return null;
    }
    if (hasQueuedLocalFollowUp(codexThreadId)) {
      return disableRemoteForLocalTakeover(config, codexThreadId, active);
    }

    const socketWait = startWebSocketWait(config, codexThreadId);
    if (!socketWait) {
      return null;
    }

    let replyId = null;
    let done = false;
    socketWait.replyId.then(function onReply(value) {
      replyId = value;
      done = true;
    }, function onError() {
      done = true;
    });
    await Promise.resolve();

    try {
      while (!done && Date.now() < deadline) {
        const latestActive = readActiveThreads();
        if (!latestActive.threads[codexThreadId]) {
          return null;
        }
        if (hasQueuedLocalFollowUp(codexThreadId)) {
          return disableRemoteForLocalTakeover(config, codexThreadId, latestActive);
        }
        await sleep(Math.min(localFollowUpCheckMs, Math.max(0, deadline - Date.now())));
      }

      if (replyId) {
        return claimReplyById(config, codexThreadId, replyId);
      }
    } finally {
      socketWait.close();
    }

    if (Date.now() >= deadline) {
      return null;
    }

    const retryDelay = WEBSOCKET_RECONNECT_BACKOFF_MS[Math.min(attempt, WEBSOCKET_RECONNECT_BACKOFF_MS.length - 1)];
    const sleepUntil = Date.now() + Math.min(retryDelay, Math.max(0, deadline - Date.now()));
    while (Date.now() < sleepUntil) {
      const active = readActiveThreads();
      if (!active.threads[codexThreadId]) {
        return null;
      }
      if (hasQueuedLocalFollowUp(codexThreadId)) {
        return disableRemoteForLocalTakeover(config, codexThreadId, active);
      }
      await sleep(Math.min(localFollowUpCheckMs, Math.max(0, deadline - Date.now())));
    }
  }

  return null;
}

async function prepareReplyForContinuation(codexThreadId, reply) {
  // Best effort: text prompts should continue even if an attachment download
  // fails, and the continuation prompt should tell Codex about the failure.
  try {
    return {
      ...reply,
      attachmentPaths: await downloadReplyMedia(codexThreadId, reply),
    };
  } catch (error) {
    return {
      ...reply,
      attachmentPaths: [],
      attachmentError: error instanceof Error ? error.message : String(error),
    };
  }
}

function attachmentLines(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return [];
  }
  return [
    "Attached images:",
    ...paths.map(function formatPath(filePath, index) {
      return `${index + 1}. ${filePath}`;
    }),
  ];
}

function continuationForReply(reply) {
  // This text becomes the next local Codex user message. The visible block gives
  // the local thread context, while the "User message to answer" section is the
  // actual remote prompt Codex should respond to.
  const body = String(reply.body || "");
  const lines = body ? body.split(/\r?\n/) : [];
  const visibleRemoteMessageLines = lines
    .map(quoteRemoteLine)
    .concat(attachmentLines(reply.attachmentPaths).map(quoteRemoteLine));
  const visibleRemoteMessage = visibleRemoteMessageLines.join("\n");
  const userMessageParts = [
    body,
    attachmentLines(reply.attachmentPaths).join("\n"),
  ].filter(Boolean);
  if (reply.attachmentError) {
    userMessageParts.push("Attached images could not be downloaded: " + reply.attachmentError);
  }

  return [
    "Treat the following remote message exactly as if the user typed it directly in this chat.",
    "Do not mention remote control, queued replies, claimed replies, Stop hooks, WebSockets, or message receipt.",
    "Start your assistant response with the local display block below exactly as shown, then a blank line, then the substantive answer, code changes, or work summary you would normally give the user.",
    "The blockquote is visible in the local Codex thread; the Stop hook removes this leading display block before sending the answer back over iMessage.",
    "Do not otherwise repeat or paraphrase the remote message.",
    "",
    "Local display block to render:",
    LOCAL_ONLY_START,
    visibleRemoteMessage,
    "",
    "User message to answer:",
    userMessageParts.join("\n\n"),
  ].join("\n");
}

function continuationForLocalTakeover() {
  return [
    "Remote Control was active, but the user has sent a message locally in Codex.",
    "Start your assistant response with this friendly note, then a blank line, then continue normally with the user's local message:",
    "\"Got it - I'll turn off Remote Control since you're back here in Codex.\"",
    "Do not mention Stop hooks, queued follow-ups, WebSockets, message receipt, or implementation details.",
  ].join("\n");
}

async function main() {
try {
  // Codex passes Stop hook context through stdin. If this is not an active remote
  // thread, exit silently so normal Codex usage is unaffected.
  const input = await readStdinJson();
  const codexThreadId = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!codexThreadId) {
    process.exit(0);
  }

  const config = readConfig();
  const active = readActiveThreads();
  const thread = active.threads[codexThreadId];
  if (!thread) {
    process.exit(0);
  }
  if (hasQueuedLocalFollowUp(codexThreadId)) {
    await disableRemoteSilently(config, codexThreadId, active);
    console.log(JSON.stringify({
      decision: "block",
      reason: continuationForLocalTakeover(),
    }));
    process.exit(0);
  }

  const stoppedAt = new Date().toISOString();
  const generated = readGeneratedImages(codexThreadId, thread);
  const lastAssistantMessage = thread.skipNextStatusSend
    ? null
    : sanitizeAssistantMessage(input.last_assistant_message);
  const statusResult = await apiFetch(config, `/threads/${encodeURIComponent(codexThreadId)}/status`, {
    method: "POST",
    body: JSON.stringify({
      cwd,
      lastAssistantMessage,
      generatedImages: generated.images,
      status: "stopped",
      createdAt: stoppedAt,
    }),
  });

  const sentGeneratedImageEvents = new Set(Array.isArray(thread.sentGeneratedImageEvents)
    ? thread.sentGeneratedImageEvents
    : []);
  const generatedImagesSent = generated.images.length > 0
    && (!statusResult || !statusResult.notification || statusResult.notification.sent !== false);
  if (generatedImagesSent) {
    for (const image of generated.images) {
      sentGeneratedImageEvents.add(image.eventId);
    }
  }

  const latestActive = readActiveThreads();
  if (!latestActive.threads[codexThreadId]) {
    process.exit(0);
  }
  if (hasQueuedLocalFollowUp(codexThreadId)) {
    await disableRemoteSilently(config, codexThreadId, latestActive);
    console.log(JSON.stringify({
      decision: "block",
      reason: continuationForLocalTakeover(),
    }));
    process.exit(0);
  }
  latestActive.threads[codexThreadId] = {
    ...thread,
    cwd,
    lastStopAt: stoppedAt,
    lastGeneratedImageScanAt: generated.images.length === 0 || generatedImagesSent
      ? stoppedAt
      : thread.lastGeneratedImageScanAt,
    sentGeneratedImageEvents: [...sentGeneratedImageEvents],
    skipNextStatusSend: false,
    ...(generated.sessionLogPath ? { sessionLogPath: generated.sessionLogPath } : {}),
  };
  writeActiveThreads(latestActive);

  const reply = await waitForReplyWhileActive(config, codexThreadId);
  if (reply && reply.localTakeover) {
    console.log(JSON.stringify({
      decision: "block",
      reason: continuationForLocalTakeover(),
    }));
  } else if (reply) {
    // "block" tells Codex to immediately continue with this synthetic user
    // message instead of ending the turn.
    const preparedReply = await prepareReplyForContinuation(codexThreadId, reply);
    console.log(JSON.stringify({
      decision: "block",
      reason: continuationForReply(preparedReply),
    }));
  }
} catch {
  // Stop hooks should never break normal Codex turns. Fail closed to silence.
}
}

main().then(function exitOk() {
  process.exit(0);
}, function exitOk() {
  process.exit(0);
});
