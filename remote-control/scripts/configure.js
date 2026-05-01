#!/usr/bin/env node
const os = require("os");
const path = require("path");
const {
  configPath,
  createInstallToken,
  defaultRelayUrl,
  ensureStateDirs,
  readJson,
  uninstallStopHook,
  writeJson,
} = require("./common.js");
const { existsSync } = require("fs");

// configure is the small imperative surface behind natural-language skill
// commands such as "use this relay URL" or "reset my token".

function readArg(name) {
  const prefix = "--" + name + "=";
  const match = process.argv.find(function findArg(arg) {
    return arg.indexOf(prefix) === 0;
  });
  return match ? match.slice(prefix.length) : "";
}

function normalizeRelayUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+/.test(normalized) && !/^http:\/\/127\.0\.0\.1(?::\d+)?/.test(normalized)) {
    throw new Error("Relay URL must be https://... or local http://127.0.0.1 for development.");
  }
  return normalized;
}

function readExistingConfig() {
  ensureStateDirs();
  return existsSync(configPath) ? readJson(configPath) : null;
}

function redactedConfig(config) {
  return {
    apiBaseUrl: config.apiBaseUrl,
    token: config.token ? "<redacted>" : "",
    stopWaitSeconds: config.stopWaitSeconds,
  };
}

async function writeRelayConfig(apiBaseUrl, options) {
  const existing = readExistingConfig();
  const token = options.resetToken || !existing?.token || existing.apiBaseUrl !== apiBaseUrl
    ? await createInstallToken(apiBaseUrl)
    : existing.token;
  const config = {
    apiBaseUrl,
    token,
    stopWaitSeconds: Number(existing?.stopWaitSeconds) || 86400,
  };
  writeJson(configPath, config);
  return {
    ok: true,
    tokenCreated: token !== existing?.token,
    configPath,
    config: redactedConfig(config),
  };
}

async function main() {
  const command = process.argv[2] || "show";
  if (command === "show") {
    const existing = readExistingConfig();
    console.log(JSON.stringify({
      ok: true,
      configured: Boolean(existing),
      configPath,
      config: existing ? redactedConfig(existing) : null,
    }, null, 2));
    return;
  }

  if (command === "set-relay") {
    const apiBaseUrl = normalizeRelayUrl(readArg("url"));
    console.log(JSON.stringify(await writeRelayConfig(apiBaseUrl, { resetToken: true }), null, 2));
    return;
  }

  if (command === "reset-token") {
    const existing = readExistingConfig();
    const apiBaseUrl = normalizeRelayUrl(existing?.apiBaseUrl || defaultRelayUrl);
    console.log(JSON.stringify(await writeRelayConfig(apiBaseUrl, { resetToken: true }), null, 2));
    return;
  }

  if (command === "use-default-relay") {
    const apiBaseUrl = normalizeRelayUrl(defaultRelayUrl);
    console.log(JSON.stringify(await writeRelayConfig(apiBaseUrl, { resetToken: true }), null, 2));
    return;
  }

  if (command === "uninstall") {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const hooksPath = path.join(codexHome, "hooks.json");
    const hooksRemoved = uninstallStopHook(hooksPath);
    console.log(JSON.stringify({
      ok: true,
      hooksRemoved,
      hooksPath,
    }, null, 2));
    return;
  }

  throw new Error("Usage: configure.js show | set-relay --url=https://... | reset-token | use-default-relay | uninstall");
}

main().catch(function onError(error) {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
