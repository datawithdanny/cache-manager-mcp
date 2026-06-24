#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_STORE_DIR = path.join(
  os.homedir(),
  ".cache",
  "cache-manager-mcp",
);
const STORE_DIR = process.env.CACHE_MANAGER_STORE_DIR ?? DEFAULT_STORE_DIR;
const SESSION_FILE = path.join(STORE_DIR, "sessions.json");
const ALIASES_FILE = path.join(STORE_DIR, "aliases.json");
const NOTIFIER_STATE_FILE = path.join(STORE_DIR, "notifier-state.json");
const PROMPT_DIR = path.join(STORE_DIR, "notification-prompts");

const POLL_SECONDS = positiveNumberEnv("CACHE_MANAGER_NOTIFY_POLL_SECONDS", 10);
const IDLE_WARNING_SECONDS = positiveNumberEnv(
  "CACHE_MANAGER_NOTIFY_IDLE_WARNING_SECONDS",
  180,
);
const IDLE_SECONDS = positiveNumberEnv(
  "CACHE_MANAGER_NOTIFY_IDLE_SECONDS",
  240,
);
const COPY_ON_IDLE = boolEnv("CACHE_MANAGER_NOTIFY_COPY_ON_IDLE", true);
const CLICK_TO_COPY = boolEnv("CACHE_MANAGER_NOTIFY_CLICK_TO_COPY", false);
const ENABLED = boolEnv("CACHE_MANAGER_NOTIFIER_ENABLED", true);
const DELIVERY = process.env.CACHE_MANAGER_NOTIFY_DELIVERY ?? "auto";
const ONCE = process.argv.includes("--once");

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(String(raw).toLowerCase());
}

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function slug(value) {
  return (
    String(value ?? "session")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "session"
  );
}

function executablePath(command) {
  const candidates = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else {
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (directory) candidates.push(path.join(directory, command));
    }
    if (os.platform() === "darwin") {
      candidates.push(
        path.join("/opt/homebrew/bin", command),
        path.join("/usr/local/bin", command),
      );
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function aliasesBySessionId() {
  const aliases = readJson(ALIASES_FILE, {});
  const bySessionId = new Map();
  for (const record of Object.values(aliases)) {
    if (
      record?.session_id &&
      record?.alias &&
      !bySessionId.has(record.session_id)
    ) {
      bySessionId.set(record.session_id, record.alias);
    }
  }
  return bySessionId;
}

function buildHandoffPrompt(session, alias) {
  const target = alias
    ? `alias \`${alias}\``
    : `session_id \`${session.id || "default"}\``;
  const resumeArgs = alias
    ? { alias }
    : { session_id: session.id || "default" };

  return [
    "Please summarize this existing agent chat as a compact handoff memory.",
    "",
    "Include:",
    "- user goal",
    "- current project/workspace",
    "- files created or modified",
    "- important design decisions",
    "- completed work",
    "- validation commands and results",
    "- unresolved issues",
    "- exact next steps",
    "",
    `After summarizing, call cache-manager.checkpoint for ${target} with title \`Handoff memory\`, tags [\"handoff\", \"cache-manager\"], and restart_session=true.`,
    "If TTL is expired or context reset is needed, stop substantive work after checkpointing and give me the restart prompt for a new agent chat.",
    "",
    "Fresh-chat resume prompt after checkpoint:",
    `Resume cache-manager ${target}.`,
    `Before doing anything else, call cache-manager.resume_or_start with ${JSON.stringify(
      {
        ...resumeArgs,
        label: "Resumed from notification handoff",
        ttl_seconds: 300,
        warn_before_seconds: 45,
        idle_seconds: 240,
      },
    )}; read any returned memory content as restart context, then continue with my next goal.`,
  ].join("\n");
}

function promptPathForSessionId(sessionId) {
  return path.join(PROMPT_DIR, `${slug(sessionId)}.txt`);
}

function writePromptFile(session, alias) {
  const prompt = buildHandoffPrompt(session, alias);
  const promptPath = promptPathForSessionId(session.id || "default");
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, prompt);
  return { prompt, promptPath };
}

function copyToClipboard(text) {
  const platform = os.platform();
  if (platform === "darwin") {
    const result = spawnSync("pbcopy", { input: text, encoding: "utf8" });
    return result.status === 0;
  }

  if (platform === "linux") {
    for (const command of ["wl-copy", "xclip", "xsel"]) {
      const args =
        command === "xclip"
          ? ["-selection", "clipboard"]
          : command === "xsel"
            ? ["--clipboard", "--input"]
            : [];
      const result = spawnSync(command, args, {
        input: text,
        encoding: "utf8",
      });
      if (result.status === 0) return true;
    }
  }

  if (platform === "win32") {
    const result = spawnSync("clip", {
      input: text,
      encoding: "utf8",
      shell: true,
    });
    return result.status === 0;
  }

  return false;
}

function copyPromptForSession(sessionId) {
  const promptPath = promptPathForSessionId(sessionId);
  if (!fs.existsSync(promptPath)) {
    console.error(`no cached handoff prompt found for session: ${sessionId}`);
    process.exitCode = 1;
    return;
  }

  const copied = copyToClipboard(fs.readFileSync(promptPath, "utf8"));
  console.log(
    copied
      ? `copied handoff prompt for ${sessionId}`
      : `failed to copy handoff prompt for ${sessionId}`,
  );
  process.exitCode = copied ? 0 : 1;
}

function notify(title, message, options = {}) {
  if (DELIVERY === "log") {
    console.log(`[${title}] ${message}`);
    if (options.execute) console.log(`notification action: ${options.execute}`);
    return;
  }

  const platform = os.platform();
  const terminalNotifier =
    platform === "darwin" && options.execute && CLICK_TO_COPY
      ? executablePath("terminal-notifier")
      : null;
  if (terminalNotifier) {
    spawnSync(terminalNotifier, [
      "-title",
      title,
      "-message",
      message,
      "-execute",
      options.execute,
    ]);
    return;
  }

  if (platform === "darwin") {
    spawnSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
    return;
  }

  if (platform === "linux") {
    const result = spawnSync("notify-send", [title, message]);
    if (result.status === 0) return;
  }

  if (platform === "win32") {
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') > $null; $n = new-object system.windows.forms.notifyicon; $n.icon = [System.Drawing.SystemIcons]::Information; $n.visible = $true; $n.showballoontip(5000, ${JSON.stringify(title)}, ${JSON.stringify(message)}, [system.windows.forms.tooltipicon]::Warning)`,
      ],
      { shell: false },
    );
    return;
  }

  console.log(`[${title}] ${message}`);
}

function sessionIdleMs(session, now) {
  const lastActionAtMs = Number(session.last_action_at_ms);
  if (!Number.isFinite(lastActionAtMs)) return 0;
  return Math.max(0, now - lastActionAtMs);
}

function pruneState(state, sessions) {
  const sessionIds = new Set(Object.keys(sessions));
  for (const key of Object.keys(state.sessions || {})) {
    if (!sessionIds.has(key)) delete state.sessions[key];
  }
}

function clickToCopyCommand(sessionId) {
  const envPrefix = `CACHE_MANAGER_STORE_DIR=${JSON.stringify(STORE_DIR)}`;
  return `${envPrefix} ${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT_PATH)} --copy-prompt ${JSON.stringify(sessionId)}`;
}

function checkSessions() {
  if (!ENABLED) {
    console.log(
      "cache-manager notifier disabled by CACHE_MANAGER_NOTIFIER_ENABLED",
    );
    return;
  }

  const sessions = readJson(SESSION_FILE, {});
  const aliasBySessionId = aliasesBySessionId();
  const state = readJson(NOTIFIER_STATE_FILE, { sessions: {} });
  state.sessions ||= {};
  pruneState(state, sessions);

  const now = Date.now();
  for (const session of Object.values(sessions)) {
    if (!session?.id) continue;

    const idleMs = sessionIdleMs(session, now);
    const idleSeconds = Math.floor(idleMs / 1000);
    const sessionState = state.sessions[session.id] || {};
    const lastActionAtMs = Number(session.last_action_at_ms) || 0;

    if (sessionState.last_action_at_ms !== lastActionAtMs) {
      delete sessionState.warning_sent_at;
      delete sessionState.idle_sent_at;
      sessionState.last_action_at_ms = lastActionAtMs;
    }

    const alias = aliasBySessionId.get(session.id);
    const label = session.label || alias || session.id;
    const notificationLabel = alias ? `Alias ${alias}: ${label}` : label;

    if (idleSeconds >= IDLE_WARNING_SECONDS && !sessionState.warning_sent_at) {
      notify(
        "Cache Manager",
        `${notificationLabel} has had no heartbeat for ${formatDuration(idleMs)}. Consider checkpointing soon.`,
      );
      sessionState.warning_sent_at = nowIso();
      console.log(
        `sent ${IDLE_WARNING_SECONDS}s idle warning for ${session.id}`,
      );
    }

    if (idleSeconds >= IDLE_SECONDS && !sessionState.idle_sent_at) {
      const { prompt, promptPath } = writePromptFile(session, alias);
      let copied = false;
      if (COPY_ON_IDLE) {
        copied = copyToClipboard(prompt);
      }

      const execute = CLICK_TO_COPY ? clickToCopyCommand(session.id) : null;
      notify(
        "Cache Manager",
        copied
          ? `${notificationLabel} is idle for ${formatDuration(idleMs)}. Handoff prompt copied to clipboard.`
          : CLICK_TO_COPY
            ? `${notificationLabel} is idle for ${formatDuration(idleMs)}. Click to copy handoff prompt.`
            : `${notificationLabel} is idle for ${formatDuration(idleMs)}. Ask the agent to checkpoint this chat.`,
        { execute },
      );
      sessionState.idle_sent_at = nowIso();
      sessionState.prompt_copied = copied;
      sessionState.prompt_path = promptPath;
      console.log(
        `sent ${IDLE_SECONDS}s idle alert for ${session.id}${copied ? " and copied prompt" : ""}`,
      );
    }

    state.sessions[session.id] = sessionState;
  }

  writeJson(NOTIFIER_STATE_FILE, state);
}

function main() {
  const copyPromptIndex = process.argv.indexOf("--copy-prompt");
  if (copyPromptIndex !== -1) {
    copyPromptForSession(process.argv[copyPromptIndex + 1] || "default");
    return;
  }

  fs.mkdirSync(STORE_DIR, { recursive: true });
  console.log(
    `cache-manager notifier watching ${SESSION_FILE} every ${POLL_SECONDS}s; warning=${IDLE_WARNING_SECONDS}s idle=${IDLE_SECONDS}s copy=${COPY_ON_IDLE} click_to_copy=${CLICK_TO_COPY} delivery=${DELIVERY}`,
  );

  checkSessions();
  if (!ONCE) {
    setInterval(checkSessions, POLL_SECONDS * 1000);
  }
}

main();
