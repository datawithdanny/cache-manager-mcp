#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const notifierPath = path.join(
  repoRoot,
  "server",
  "cache-manager-notifier.mjs",
);
const storeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "cache-manager-notifier-smoke-"),
);
const now = Date.now();

const sessions = {
  warning: {
    id: "warning",
    label: "Smoke warning session",
    ttl_ms: 300000,
    warn_before_ms: 45000,
    idle_ms: 240000,
    started_at_ms: now - 200000,
    last_action_at_ms: now - 181000,
    started_at: new Date(now - 200000).toISOString(),
    last_action_at: new Date(now - 181000).toISOString(),
    actions: [],
  },
  idle: {
    id: "idle",
    label: "Smoke idle session",
    ttl_ms: 300000,
    warn_before_ms: 45000,
    idle_ms: 240000,
    started_at_ms: now - 260000,
    last_action_at_ms: now - 241000,
    started_at: new Date(now - 260000).toISOString(),
    last_action_at: new Date(now - 241000).toISOString(),
    actions: [],
  },
};

const aliases = {
  "smoke-warning": {
    alias: "smoke-warning",
    session_id: "warning",
    title: "Smoke warning session",
    created_at: new Date(now - 200000).toISOString(),
    updated_at: new Date(now - 200000).toISOString(),
  },
  "smoke-idle": {
    alias: "smoke-idle",
    session_id: "idle",
    title: "Smoke idle session",
    created_at: new Date(now - 260000).toISOString(),
    updated_at: new Date(now - 260000).toISOString(),
  },
};

fs.writeFileSync(
  path.join(storeDir, "sessions.json"),
  `${JSON.stringify(sessions, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(storeDir, "aliases.json"),
  `${JSON.stringify(aliases, null, 2)}\n`,
);

const result = spawnSync(process.execPath, [notifierPath, "--once"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CACHE_MANAGER_STORE_DIR: storeDir,
    CACHE_MANAGER_NOTIFY_DELIVERY: "log",
    CACHE_MANAGER_NOTIFY_COPY_ON_IDLE: "false",
    CACHE_MANAGER_NOTIFY_CLICK_TO_COPY: "true",
  },
  encoding: "utf8",
});

const output = `${result.stdout || ""}${result.stderr || ""}`;
const statePath = path.join(storeDir, "notifier-state.json");
const promptPath = path.join(storeDir, "notification-prompts", "idle.txt");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

const checks = [
  [result.status === 0, "notifier exited successfully"],
  [
    output.includes("sent 180s idle warning for warning"),
    "warning threshold fired",
  ],
  [output.includes("sent 240s idle alert for idle"), "idle threshold fired"],
  [
    output.includes("notification action:"),
    "click-to-copy action was rendered in log mode",
  ],
  [
    output.includes(
      "Alias smoke-warning: Smoke warning session has had no heartbeat",
    ),
    "warning notification includes alias prefix",
  ],
  [
    output.includes("Alias smoke-idle: Smoke idle session is idle"),
    "idle notification includes alias prefix",
  ],
  [Boolean(state.sessions.warning.warning_sent_at), "warning state persisted"],
  [Boolean(state.sessions.idle.idle_sent_at), "idle state persisted"],
  [fs.existsSync(promptPath), "handoff prompt file created"],
];

const failed = checks.filter(([ok]) => !ok);
if (failed.length > 0) {
  console.error(output);
  for (const [, message] of failed) {
    console.error(`FAILED: ${message}`);
  }
  process.exit(1);
}

console.log(output.trim());
console.log(`smoke notifier test passed with temp store: ${storeDir}`);
