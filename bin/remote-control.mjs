#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillSourceDir = path.join(packageDir, "remote-control");

function readArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : "";
}

function readJson(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function installSkill(skillTargetDir, codexHome) {
  // Reinstall the packaged skill files, but keep .state so upgrades do not
  // accidentally lose the user's token or active thread list.
  mkdirSync(path.dirname(skillTargetDir), { recursive: true });
  const statePath = path.join(skillTargetDir, ".state");
  const preservedStatePath = path.join(codexHome, `.remote-control-state-${process.pid}`);
  const hasState = existsSync(statePath);
  if (hasState) {
    rmSync(preservedStatePath, { recursive: true, force: true });
    renameSync(statePath, preservedStatePath);
  }
  rmSync(skillTargetDir, { recursive: true, force: true });
  cpSync(skillSourceDir, skillTargetDir, { recursive: true, force: true, verbatimSymlinks: true });
  if (hasState) {
    rmSync(path.join(skillTargetDir, ".state"), { recursive: true, force: true });
    renameSync(preservedStatePath, path.join(skillTargetDir, ".state"));
  }
}

function uninstallStopHook(hooksPath) {
  // Uninstall is intentionally narrow: the user may remove/disable the skill in
  // Codex, and this command only removes the global Stop hook we added.
  if (!existsSync(hooksPath)) {
    return 0;
  }

  const root = readJson(hooksPath, {});
  const hooks = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? root.hooks : {};
  const groups = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  let removed = 0;
  const nextGroups = [];

  for (const group of groups) {
    if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
      nextGroups.push(group);
      continue;
    }
    const nextHooks = group.hooks.filter((hook) => {
      const shouldRemove = hook
        && typeof hook === "object"
        && typeof hook.command === "string"
        && hook.command.includes("publish-stop.js");
      if (shouldRemove) {
        removed += 1;
      }
      return !shouldRemove;
    });
    if (nextHooks.length > 0) {
      nextGroups.push({ ...group, hooks: nextHooks });
    }
  }

  if (removed > 0) {
    if (nextGroups.length > 0) {
      hooks.Stop = nextGroups;
    } else {
      delete hooks.Stop;
    }
    root.hooks = hooks;
    writeJson(hooksPath, root);
  }

  return removed;
}

function install() {
  // Keep the npx installer as a lightweight compatibility path. First-use relay
  // choice and hook installation happen later through the skill conversation.
  const codexHome = readArg("codex-home") || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const skillTargetDir = path.join(codexHome, "skills", "remote-control");
  const configPath = path.join(skillTargetDir, ".state", "config.json");
  const hooksPath = path.join(codexHome, "hooks.json");
  const existingConfig = readJson(configPath, null);

  installSkill(skillTargetDir, codexHome);

  console.log(JSON.stringify({
    ok: true,
    configured: Boolean(existingConfig),
    hookInstalled: false,
    skillPath: skillTargetDir,
    hooksPath,
  }, null, 2));
}

function uninstall() {
  const codexHome = readArg("codex-home") || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const hooksPath = path.join(codexHome, "hooks.json");
  const hooksRemoved = uninstallStopHook(hooksPath);

  console.log(JSON.stringify({
    ok: true,
    hooksRemoved,
    hooksPath,
  }, null, 2));
}

const command = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "install";
if (command !== "install" && command !== "uninstall") {
  console.error("Usage: remote-control install [--codex-home=/path]\n       remote-control uninstall [--codex-home=/path]");
  process.exit(2);
}

if (command === "install") {
  try {
    install();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {
  try {
    uninstall();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
