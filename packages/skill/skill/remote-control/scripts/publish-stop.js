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
  const url = new URL(config.apiBaseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.pathname = `/threads/${encodeURIComponent(codexThreadId)}/events`;
  url.search = "";
  url.searchParams.set("token", config.token);
  return url.toString();
}

function recordMockWebSocketProbe(config, codexThreadId, payload) {
  if (!process.env.REMOTE_CONTROL_MOCK_FILE) {
    return false;
  }

  const mockPath = process.env.REMOTE_CONTROL_MOCK_FILE;
  const mock = existsSync(mockPath) ? JSON.parse(readFileSync(mockPath, "utf8")) : {};
  mock.websocketCalls = Array.isArray(mock.websocketCalls) ? mock.websocketCalls : [];
  mock.websocketCalls.push({
    method: "WS",
    path: `/threads/${codexThreadId}/events`,
    authorization: "Bearer " + config.token,
    body: payload,
  });
  writeFileSync(mockPath, JSON.stringify(mock, null, 2) + "\n", "utf8");
  return true;
}

function startWebSocketProbe(config, codexThreadId) {
  const payload = {
    type: "stop-hook-connected",
    threadId: codexThreadId,
    sentAt: new Date().toISOString(),
  };

  if (recordMockWebSocketProbe(config, codexThreadId, payload)) {
    return { close: function closeMockProbe() {} };
  }
  if (typeof WebSocket !== "function") {
    return null;
  }

  try {
    const socket = new WebSocket(threadEventsUrl(config, codexThreadId));
    socket.addEventListener("open", function onOpen() {
      socket.send(JSON.stringify(payload));
    });
    socket.addEventListener("message", function onMessage() {
      // Probe-only path: receipt is useful for platform validation, not delivery.
    });
    socket.addEventListener("error", function onError() {
      // Polling remains authoritative, so socket failures stay silent.
    });
    return {
      close: function closeProbe() {
        if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
          socket.close(1000, "stop hook finished");
        }
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

async function claimNextReply(config, codexThreadId) {
  const encodedThreadId = encodeURIComponent(codexThreadId);
  const pending = await apiFetch(config, `/threads/${encodedThreadId}/pending`);
  const reply = Array.isArray(pending.replies) ? pending.replies[0] : null;
  if (!reply) {
    return null;
  }

  const claimed = await apiFetch(
    config,
    `/threads/${encodedThreadId}/replies/${encodeURIComponent(reply.id)}/claim`,
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

async function waitForReplyWhileActive(config, codexThreadId) {
  const deadline = Date.now() + Math.max(0, config.stopPollSeconds) * 1000;
  const intervalMs = Math.max(1, config.stopPollIntervalSeconds) * 1000;
  const localFollowUpCheckMs = 250;
  const websocketProbe = startWebSocketProbe(config, codexThreadId);

  try {
    while (true) {
      const active = readActiveThreads();
      if (!active.threads[codexThreadId]) {
        return null;
      }
      if (hasQueuedLocalFollowUp(codexThreadId)) {
        await disableRemoteSilently(config, codexThreadId, active);
        return null;
      }

      const reply = await claimNextReply(config, codexThreadId);
      if (reply) {
        return reply;
      }
      if (Date.now() >= deadline) {
        return null;
      }
      const sleepUntil = Date.now() + Math.min(intervalMs, Math.max(0, deadline - Date.now()));
      while (Date.now() < sleepUntil) {
        await sleep(Math.min(localFollowUpCheckMs, Math.max(0, sleepUntil - Date.now())));
        const latestActive = readActiveThreads();
        if (!latestActive.threads[codexThreadId]) {
          return null;
        }
        if (hasQueuedLocalFollowUp(codexThreadId)) {
          await disableRemoteSilently(config, codexThreadId, latestActive);
          return null;
        }
      }
    }
  } finally {
    if (websocketProbe) {
      websocketProbe.close();
    }
  }
}

async function prepareReplyForContinuation(codexThreadId, reply) {
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
    "Do not mention remote control, queued replies, claimed replies, Stop hooks, polling, or message receipt.",
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

async function main() {
try {
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
  if (reply) {
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
