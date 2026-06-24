#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateUsage,
  formatStats,
  resolveTranscriptSessionIds,
} from "./transcript-stats.mjs";
import { computeMcpOverhead, formatOverhead } from "./mcp-overhead.mjs";
import { startWebDashboard } from "./cache-manager-web.mjs";
import { buildRestartPrompt } from "./dashboard-data.mjs";
import {
  DEFAULT_TTL_MS,
  DEFAULT_WARN_BEFORE_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_CHECKPOINT_AFTER_ACTIONS,
  DEFAULT_CHECKPOINT_AFTER_MS,
  DEFAULT_MAX_TURN_MS,
  formatDuration,
  nowIso,
  nowMs,
  sessionStatus,
} from "./session-status.mjs";

const STORE_DIR =
  process.env.CACHE_MANAGER_STORE_DIR ??
  path.join(os.homedir(), ".cache", "cache-manager-mcp");
const MEMORY_DIR = path.join(STORE_DIR, "memories");
const SESSION_FILE = path.join(STORE_DIR, "sessions.json");
const ALIASES_FILE = path.join(STORE_DIR, "aliases.json");

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// Memory retention: prune accumulating handoff memories. The newest memory per
// alias is protected by default so resume_or_start / latest_memory can always
// restore a thread, no matter how old its last checkpoint is.
const RETENTION_DAYS = numberEnv("CACHE_MANAGER_RETENTION_DAYS", 30);
const KEEP_LATEST_PER_ALIAS = boolEnv(
  "CACHE_MANAGER_KEEP_LATEST_PER_ALIAS",
  true,
);
const PRUNE_ON_STARTUP = boolEnv("CACHE_MANAGER_PRUNE_ON_STARTUP", true);

fs.mkdirSync(MEMORY_DIR, { recursive: true });

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

function readSessions() {
  return readJson(SESSION_FILE, {});
}

function writeSessions(sessions) {
  writeJson(SESSION_FILE, sessions);
}

function readAliases() {
  return readJson(ALIASES_FILE, {});
}

function writeAliases(aliases) {
  writeJson(ALIASES_FILE, aliases);
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

function resolveSessionId(args = {}) {
  if (args.session_id) return args.session_id;
  if (!args.alias) return "default";

  const aliases = readAliases();
  const record = aliases[args.alias];
  if (!record?.session_id) {
    throw new Error(`unknown memory alias: ${args.alias}`);
  }
  return record.session_id;
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};

  const metadata = {};
  const lines = content.slice(4, end).split("\n");
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    try {
      metadata[key] = JSON.parse(rawValue);
    } catch {
      metadata[key] = rawValue;
    }
  }
  return metadata;
}

function readMemoryEntries() {
  return fs
    .readdirSync(MEMORY_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const fullPath = path.join(MEMORY_DIR, file);
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, "utf8");
      const metadata = parseFrontmatter(content);
      return {
        file,
        path: fullPath,
        mtime_ms: stat.mtimeMs,
        title: metadata.title,
        session_id: metadata.session_id,
        alias: metadata.alias,
        created_at: metadata.created_at,
        tags: metadata.tags || [],
        content,
      };
    })
    .sort((a, b) => b.mtime_ms - a.mtime_ms);
}

// Group by session_id: this is exactly the key latestMemoryForSession() filters
// on, so protecting the newest entry per group guarantees latest_memory /
// resume_or_start can still restore each thread. (session_id is derived from the
// alias, so this is equivalent to "latest per alias" for normally-saved memories.)
function memoryGroupKey(entry) {
  return entry.session_id || entry.alias || entry.file;
}

function memoryTimeMs(entry) {
  const parsed = entry.created_at ? Date.parse(entry.created_at) : NaN;
  return Number.isNaN(parsed) ? entry.mtime_ms : parsed;
}

// Delete accumulating handoff memories per the retention policy. Defaults come
// from the CACHE_MANAGER_* env vars but every knob can be overridden per call.
//   - keep_latest_per_alias: never delete the newest memory of each alias.
//   - delete_non_latest: delete every memory that is not the newest of its
//     alias (regardless of age) -> "only keep latest per alias".
//   - retention_days: delete memories older than this many days (0 disables
//     age-based pruning).
//   - dry_run: report what would be deleted without removing anything.
function pruneMemories(options = {}) {
  const retentionDays = Number(options.retention_days ?? RETENTION_DAYS);
  const keepLatestPerAlias =
    options.keep_latest_per_alias ?? KEEP_LATEST_PER_ALIAS;
  const deleteNonLatest = options.delete_non_latest ?? false;
  const dryRun = options.dry_run ?? false;

  const ageCutoffMs =
    retentionDays > 0 ? nowMs() - retentionDays * 24 * 60 * 60 * 1000 : null;

  const entries = readMemoryEntries();
  const newestByGroup = new Map();
  for (const entry of entries) {
    const key = memoryGroupKey(entry);
    const ts = memoryTimeMs(entry);
    const current = newestByGroup.get(key);
    if (!current || ts > current.ts)
      newestByGroup.set(key, { file: entry.file, ts });
  }

  const deleted = [];
  const kept = [];
  for (const entry of entries) {
    const key = memoryGroupKey(entry);
    const isLatest = newestByGroup.get(key)?.file === entry.file;
    const ts = memoryTimeMs(entry);

    let remove = false;
    let reason;
    if (isLatest && (keepLatestPerAlias || deleteNonLatest)) {
      reason = "protected: latest per alias";
    } else if (deleteNonLatest && !isLatest) {
      remove = true;
      reason = "non-latest";
    } else if (ageCutoffMs !== null && ts < ageCutoffMs) {
      remove = true;
      reason = `older than ${retentionDays}d`;
    } else {
      reason = "within retention";
    }

    const record = {
      file: entry.file,
      alias: entry.alias ?? null,
      session_id: entry.session_id ?? null,
      created_at: entry.created_at ?? null,
      reason,
    };
    if (remove) {
      if (!dryRun) {
        try {
          fs.unlinkSync(entry.path);
        } catch {
          // best-effort; skip files that vanished or can't be removed
        }
      }
      deleted.push(record);
    } else {
      kept.push(record);
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    retention_days: retentionDays,
    keep_latest_per_alias: keepLatestPerAlias,
    delete_non_latest: deleteNonLatest,
    scanned: entries.length,
    deleted_count: deleted.length,
    kept_count: kept.length,
    deleted,
    kept,
  };
}

// Restart prompt is built by the shared dashboard-data layer so the MCP tool
// output and the web dashboard's click-to-copy stay byte-identical.
const restartPrompt = buildRestartPrompt;

// Example restart/handoff prompt the agent fills in when checkpointing. Shared
// by the handoff_prompt tool and the proactive checkpoint suggestion bundle.
function handoffPromptText(args = {}, session) {
  return [
    "Summarize the conversation so far as a compact restart memory.",
    "Include: user goal, current project/files touched, important decisions, completed work, validation results, unresolved issues, and exact next steps.",
    "Avoid transcript detail. Optimize for minimizing tokens in a new session while preserving execution context.",
    `Project: ${args.project || "unspecified"}`,
    `Session: ${session.id} (${session.label})`,
    args.alias ? `Alias: ${args.alias}` : "Alias: none",
    `Status: ${JSON.stringify(sessionStatus(session))}`,
    "After producing the summary, call cache-manager.save_memory with the summary. Include alias if this is a named thread.",
    "If your MCP client supports fresh conversations, use a new conversation for true context reset after checkpointing.",
  ].join("\n");
}

// Bundle assembled when status.checkpoint_suggested fires: the reason, an
// example handoff prompt, and freshly computed usage/cost stats — everything
// the agent needs to checkpoint in one shot. Stats parse transcripts, so this
// is built ONLY when a checkpoint is actually suggested, never on every ping.
function checkpointSuggestion(args, session, status) {
  let stats = null;
  try {
    stats = computeSessionStats(args);
  } catch {
    stats = null;
  }
  const statsText = stats
    ? [
        formatStats("CURRENT SESSION", stats.current_session),
        formatStats("ALIAS LIFETIME", stats.alias_lifetime),
      ]
        .filter(Boolean)
        .join("\n")
    : null;
  return {
    reason: status.checkpoint_reason,
    handoff_prompt: handoffPromptText(args, session),
    stats,
    stats_text: statsText,
    next_step:
      "Write a compact summary, then call cache-manager.checkpoint with it (and the alias). That saves the handoff, appends these stats to the memory, and resets the work counter.",
  };
}

// Reset the proactive-checkpoint work counter for an existing session (no-op if
// none exists). Called after a handoff is saved so the hint re-arms; the
// restart-session path doesn't need this since it builds a fresh session.
function resetCheckpointCounter(args = {}) {
  try {
    const { sessions, session, id } = getSession(args, false);
    if (!session) return;
    session.last_checkpoint_at_ms = nowMs();
    session.actions_since_checkpoint = 0;
    sessions[id] = session;
    writeSessions(sessions);
  } catch {
    /* counter reset is best-effort */
  }
}

function countdownText(status) {
  const icon = status.running ? "▶️" : status.should_summarize ? "⚠️" : "⏳";
  const lines = [
    `${icon} Cache Manager Countdown`,
    "",
    `Session: ${status.session_id} (${status.label || "unlabeled"})`,
    status.running
      ? `Turn in progress: running for ${formatDuration(status.turn_elapsed_ms)}`
      : `Prompt TTL remaining: ${formatDuration(status.time_remaining_ms)}`,
    `Inactive for: ${formatDuration(status.idle_for_ms)}`,
    `Inactivity alert in: ${formatDuration(status.idle_remaining_ms)} (threshold ${formatDuration(status.idle_ms)})`,
    `Severity: ${status.severity}`,
  ];

  if (status.alert) {
    lines.push("", status.alert);
  }

  if (status.checkpoint_suggested) {
    lines.push("", `⛳ Checkpoint suggested: ${status.checkpoint_reason}.`);
  }

  lines.push("", status.recommendation);
  return lines.join("\n");
}

// Web dashboard URL, folded into the chat-start responses (start_session /
// resume_or_start) so the agent can surface the link to the user. Null until the
// server has bound its port (resolved asynchronously at startup) or when the
// dashboard is disabled; in those cases the fields are simply omitted.
function dashboardFields() {
  if (!webDashboardUrl) return {};
  return {
    dashboard_url: webDashboardUrl,
    dashboard_hint: `Live web dashboard available at ${webDashboardUrl} — share this link with the user so they can watch their tracked chats.`,
  };
}

function textResult(payload) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

// Canonical agent workflow, surfaced to MCP clients via the `instructions`
// field of the initialize result. Conforming hosts (e.g. Claude Code, Zed)
// inject this into the model's context, so the tool works out of the box with
// no AGENTS.md/CLAUDE.md copying. AGENTS.md mirrors this text word-for-word as a
// fallback for clients that ignore server instructions. Keep it tight — it is
// added to context every session.
const SERVER_INSTRUCTIONS = [
  "Cache Manager keeps per-chat context so agents can resume cheaply across sessions. Workflow:",
  "1. RESUME — at the start of a chat, call resume_or_start with a stable `alias` (one per project/task). If it returns a memory, read it as restart context before anything else. If the response includes a `dashboard_url`, surface that localhost link to the user once so they can open the live web dashboard.",
  "2. HEARTBEAT — at the start of each chat request (a new user prompt), call heartbeat with phase:'start' so the dashboard shows the chat 'running'. When you finish answering that request (after ALL the turns/tool calls needed to respond), call heartbeat with phase:'end' immediately before your final response text so the idle/TTL countdown resumes. Optionally send plain heartbeat pings (phase:'progress') after meaningful steps in between. This feeds the external dashboard; it is required for the dashboard, not a checkpoint trigger.",
  "3. CHECKPOINT at natural cut points — when you finish a substantial unit of work (a logical stopping point, usually the end of a long task), call checkpoint with a compact summary (goal, what changed, decisions, next steps). Do NOT checkpoint mid-task or merely because time has passed.",
  "4. RESUME LATER — in a new chat, call resume_or_start with the same alias to restore the latest checkpoint.",
  "TTL/idle are dashboard and cost-visibility metrics only — never a reason for the agent to checkpoint.",
].join("\n");

const tools = [
  {
    name: "start_session",
    description:
      "Start or reset a prompt TTL tracking session. Use when a new agent conversation or major prompt begins.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Stable identifier for this conversation. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
        label: {
          type: "string",
          description: "Human-readable label for the tracked conversation.",
        },
        ttl_seconds: {
          type: "number",
          description: "Prompt TTL in seconds. Defaults to 300.",
        },
        warn_before_seconds: {
          type: "number",
          description: "When to warn before TTL expiry. Defaults to 45.",
        },
        idle_seconds: {
          type: "number",
          description:
            "How long with no heartbeat before summarization is recommended. Defaults to 240 (4 minutes).",
        },
        turn_max_seconds: {
          type: "number",
          description:
            "Safety valve for the live turn timer: a running turn older than this self-heals back to non-running (handles a forgotten phase:'end'). The live timer is otherwise uncapped. Defaults to 3600 (60 minutes).",
        },
        checkpoint_after_actions: {
          type: "number",
          description:
            "Proactive checkpoint hint: suggest a checkpoint after this many heartbeats since the last checkpoint. Defaults to 20.",
        },
        checkpoint_after_minutes: {
          type: "number",
          description:
            "Proactive checkpoint hint: suggest a checkpoint after this many minutes since the last checkpoint. Defaults to 30.",
        },
        transcript_session_id: {
          type: "string",
          description:
            "Optional: this chat's own transcript/session UUID (e.g. Claude Code's CLAUDE_CODE_SESSION_ID env var), so usage/cost is attributed to exactly this chat rather than inferred. Accumulated across resumes; usually unnecessary — the server also infers ownership from the cache-manager calls recorded in the transcript.",
        },
      },
    },
  },
  {
    name: "heartbeat",
    description:
      "Record agent activity for a tracked session (drives the external dashboard's live view). Call with phase:'start' at the start of each chat request (a new user prompt) to mark the chat 'running' and start the turn timer; call with phase:'end' immediately before the final response text — after all turns/tool calls answering that request — to close it so the idle/TTL countdown resumes; or omit phase (defaults to 'progress') for a plain activity ping after meaningful steps. When a substantial chunk of work has accrued since the last checkpoint, the response also includes a checkpoint_suggestion bundle (example handoff prompt + usage/cost stats) so you can checkpoint in one shot. TTL/idle here are dashboard metrics, not a checkpoint trigger.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
        action: {
          type: "string",
          description: "Short description of the action that just happened.",
        },
        phase: {
          type: "string",
          enum: ["start", "progress", "end"],
          description:
            "Turn lifecycle phase. 'start' marks a turn in progress and starts the turn timer; 'end' closes the turn and records its duration; 'progress' (default) is a plain activity heartbeat that leaves turn state untouched.",
        },
        transcript_session_id: {
          type: "string",
          description:
            "Optional: this chat's own transcript/session UUID (e.g. Claude Code's CLAUDE_CODE_SESSION_ID env var), so usage/cost is attributed to exactly this chat. Accumulated across resumes; usually unnecessary — the server also infers ownership from the cache-manager calls recorded in the transcript.",
        },
      },
    },
  },
  {
    name: "status",
    description:
      "Return a session's current TTL/idle/turn metrics — the same view the external dashboard renders. Informational only: TTL/idle are not a checkpoint trigger.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
      },
    },
  },
  {
    name: "countdown",
    description:
      "Show a display-friendly countdown timer/status message, including prompt TTL and 4-minute inactivity alert status.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
      },
    },
  },
  {
    name: "handoff_prompt",
    description:
      "Generate a concise prompt the agent can use to summarize the current conversation for handoff memory.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
        project: {
          type: "string",
          description: "Project or workspace name to include in the prompt.",
        },
      },
    },
  },
  {
    name: "save_memory",
    description:
      "Save a handoff summary as markdown memory for later sessions.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to store with the memory and map to session_id.",
        },
        title: { type: "string", description: "Memory title." },
        summary: {
          type: "string",
          description: "Conversation summary and restart context.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags.",
        },
      },
    },
  },
  {
    name: "resume_or_start",
    description:
      "Restore the latest memory for an alias/session if available, then start a fresh TTL tracking session in one call. Prefer this at the start of every chat; if it returns a memory, read it as restart context before doing other work.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Stable identifier for this conversation.",
        },
        alias: {
          type: "string",
          description:
            "Human-friendly thread alias. If new, it is mapped to a slugged session_id.",
        },
        label: {
          type: "string",
          description: "Human-readable label for the tracked conversation.",
        },
        ttl_seconds: {
          type: "number",
          description: "Prompt TTL in seconds. Defaults to 300.",
        },
        warn_before_seconds: {
          type: "number",
          description: "When to warn before TTL expiry. Defaults to 45.",
        },
        idle_seconds: {
          type: "number",
          description:
            "How long with no heartbeat before summarization is recommended. Defaults to 240 (4 minutes).",
        },
        turn_max_seconds: {
          type: "number",
          description:
            "Safety valve for the live turn timer: a running turn older than this self-heals back to non-running (handles a forgotten phase:'end'). The live timer is otherwise uncapped. Defaults to 3600 (60 minutes).",
        },
        checkpoint_after_actions: {
          type: "number",
          description:
            "Proactive checkpoint hint: suggest a checkpoint after this many heartbeats since the last checkpoint. Defaults to 20.",
        },
        checkpoint_after_minutes: {
          type: "number",
          description:
            "Proactive checkpoint hint: suggest a checkpoint after this many minutes since the last checkpoint. Defaults to 30.",
        },
        transcript_session_id: {
          type: "string",
          description:
            "Optional: this chat's own transcript/session UUID (e.g. Claude Code's CLAUDE_CODE_SESSION_ID env var), so usage/cost is attributed to exactly this chat. Accumulated across resumes; usually unnecessary — the server also infers ownership from the cache-manager calls recorded in the transcript.",
        },
      },
    },
  },
  {
    name: "checkpoint",
    description:
      "Save a compact handoff memory and optionally start a fresh TTL session. Call this when you finish a substantial unit of work — a natural cut point, usually the end of a long task — so the next session can resume cheaply. Do NOT checkpoint mid-task or merely because time has passed. The summary should capture goal, what changed, decisions, and next steps.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to store with the memory and map to session_id.",
        },
        title: { type: "string", description: "Memory title." },
        summary: {
          type: "string",
          description: "Compact conversation summary and restart context.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags.",
        },
        restart_session: {
          type: "boolean",
          description:
            "Whether to start a fresh TTL session after saving. Defaults to true.",
        },
        label: {
          type: "string",
          description: "Human-readable label for the fresh session.",
        },
        ttl_seconds: {
          type: "number",
          description:
            "Prompt TTL in seconds for the fresh session. Defaults to 300.",
        },
        warn_before_seconds: {
          type: "number",
          description: "When to warn before TTL expiry. Defaults to 45.",
        },
        idle_seconds: {
          type: "number",
          description:
            "How long with no heartbeat before summarization is recommended. Defaults to 240 (4 minutes).",
        },
      },
    },
  },
  {
    name: "latest_memory",
    description:
      "Return the most recently saved handoff memory, optionally filtered by session_id or alias.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional session identifier to filter by.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
      },
    },
  },
  {
    name: "list_memories",
    description:
      "List saved handoff memories, optionally filtered by session_id or alias.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Optional session identifier to filter by.",
        },
        alias: {
          type: "string",
          description:
            "Optional human-friendly thread alias to resolve to a session_id.",
        },
        limit: {
          type: "number",
          description: "Maximum number of memories to return. Defaults to 10.",
        },
      },
    },
  },
  {
    name: "search_memories",
    description:
      "Search saved handoff memories by keyword across title, tags, session_id, and content.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Keyword or phrase to search for.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results. Defaults to 10.",
        },
        include_content: {
          type: "boolean",
          description:
            "Whether to include full memory content. Defaults to false.",
        },
      },
    },
  },
  {
    name: "set_alias",
    description:
      "Map a human-friendly thread alias to a session_id so older chats can restore the right memory later.",
    inputSchema: {
      type: "object",
      required: ["alias", "session_id"],
      properties: {
        alias: {
          type: "string",
          description: "Human-friendly thread name, e.g. 'my-project-thread'.",
        },
        session_id: {
          type: "string",
          description: "Session identifier to restore when this alias is used.",
        },
        title: {
          type: "string",
          description: "Optional description/title for the alias.",
        },
      },
    },
  },
  {
    name: "resolve_alias",
    description: "Resolve a human-friendly thread alias to its session_id.",
    inputSchema: {
      type: "object",
      required: ["alias"],
      properties: {
        alias: { type: "string", description: "Alias to resolve." },
      },
    },
  },
  {
    name: "list_aliases",
    description: "List known memory aliases and their target session IDs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "session_stats",
    description:
      "Report transcript-derived token/cache usage for a tracking session, plus the alias's whole lifetime as additional insight. Bridges to agent transcripts by time window. Reports turns, input/output tokens, cache read/creation, cache hit ratio, cold starts, and 5m/1h TTL split.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description:
            "Session identifier. Defaults to alias target or 'default'.",
        },
        alias: {
          type: "string",
          description:
            "Human-friendly thread alias. Its created_at anchors the alias-lifetime window.",
        },
        scope: {
          type: "string",
          enum: ["session", "alias", "both"],
          description:
            "Which windows to report: current 'session', 'alias' lifetime, or 'both' (default).",
        },
        cwd: {
          type: "string",
          description:
            "Project working directory whose transcripts to read. Defaults to the server process cwd.",
        },
        all_projects: {
          type: "boolean",
          description:
            "If true, scan transcripts across all projects instead of a single cwd. Defaults to false.",
        },
      },
    },
  },
  {
    name: "prune_memories",
    description:
      "Delete accumulating handoff memory files per the retention policy. By default keeps the newest memory per alias and deletes non-latest memories older than CACHE_MANAGER_RETENTION_DAYS (30). Also runs automatically on server startup unless disabled.",
    inputSchema: {
      type: "object",
      properties: {
        retention_days: {
          type: "number",
          description:
            "Delete memories older than this many days. 0 disables age-based pruning. Defaults to CACHE_MANAGER_RETENTION_DAYS (30).",
        },
        keep_latest_per_alias: {
          type: "boolean",
          description:
            "Never delete the newest memory of each alias. Defaults to CACHE_MANAGER_KEEP_LATEST_PER_ALIAS (true).",
        },
        delete_non_latest: {
          type: "boolean",
          description:
            "Delete every memory that is not the newest of its alias, regardless of age ('only keep latest per alias'). Defaults to false.",
        },
        dry_run: {
          type: "boolean",
          description:
            "Report what would be deleted without removing anything. Defaults to true for this tool (preview); pass false to actually delete.",
        },
      },
    },
  },
];

// Per-session config for the proactive checkpoint hint, plus its reset basis.
// Shared by both session builders so the two stay in sync.
function checkpointFields(args = {}, started) {
  const minutes = Number(args.checkpoint_after_minutes);
  return {
    last_checkpoint_at_ms: started,
    actions_since_checkpoint: 0,
    checkpoint_after_actions:
      Math.max(1, Number(args.checkpoint_after_actions)) ||
      DEFAULT_CHECKPOINT_AFTER_ACTIONS,
    checkpoint_after_ms:
      Math.max(1, minutes) * 60 * 1000 || DEFAULT_CHECKPOINT_AFTER_MS,
  };
}

// Option A explicit binding: fold an agent-supplied transcript/session UUID into
// the session's owned-transcript set (deduped). Returns the updated array.
function mergeTranscriptId(existing, id) {
  const set = new Set(Array.isArray(existing) ? existing : []);
  if (id) set.add(String(id));
  return [...set];
}

function getSession(args = {}, create = false) {
  const sessions = readSessions();
  const id = resolveSessionId(args);
  let session = sessions[id];

  if (!session && create) {
    const started = nowMs();
    session = {
      id,
      label: args.label || args.alias || id,
      ttl_ms:
        Math.max(1, Number(args.ttl_seconds || 300)) * 1000 || DEFAULT_TTL_MS,
      warn_before_ms:
        Math.max(1, Number(args.warn_before_seconds || 45)) * 1000 ||
        DEFAULT_WARN_BEFORE_MS,
      idle_ms:
        Math.max(1, Number(args.idle_seconds || 240)) * 1000 || DEFAULT_IDLE_MS,
      turn_max_ms:
        Math.max(1, Number(args.turn_max_seconds)) * 1000 ||
        DEFAULT_MAX_TURN_MS,
      started_at_ms: started,
      ttl_anchor_ms: started,
      last_action_at_ms: started,
      started_at: new Date(started).toISOString(),
      last_action_at: new Date(started).toISOString(),
      cwd: args.cwd || process.cwd(),
      actions: [],
      transcript_session_ids: mergeTranscriptId([], args.transcript_session_id),
      ...checkpointFields(args, started),
    };
    sessions[id] = session;
    writeSessions(sessions);
  }

  return { sessions, session, id };
}

function upsertAlias(alias, sessionId, title) {
  if (!alias) return null;
  const aliases = readAliases();
  const previous = aliases[alias] || {};
  const record = {
    alias,
    session_id: sessionId,
    title: title || previous.title || alias,
    created_at: previous.created_at || nowIso(),
    updated_at: nowIso(),
  };
  aliases[alias] = record;
  writeAliases(aliases);
  return record;
}

function sessionIdForMemoryLookup(args = {}) {
  if (args.session_id) return args.session_id;
  if (!args.alias) return undefined;
  const aliases = readAliases();
  return aliases[args.alias]?.session_id || slug(args.alias);
}

function latestMemoryForSession(sessionId) {
  return readMemoryEntries().find(
    (entry) => !sessionId || entry.session_id === sessionId,
  );
}

function buildSession(args = {}) {
  const id = args.session_id || (args.alias ? slug(args.alias) : "default");
  const started = nowMs();
  return {
    id,
    label: args.label || args.alias || id,
    ttl_ms:
      Math.max(1, Number(args.ttl_seconds || 300)) * 1000 || DEFAULT_TTL_MS,
    warn_before_ms:
      Math.max(1, Number(args.warn_before_seconds || 45)) * 1000 ||
      DEFAULT_WARN_BEFORE_MS,
    idle_ms:
      Math.max(1, Number(args.idle_seconds || 240)) * 1000 || DEFAULT_IDLE_MS,
    started_at_ms: started,
    ttl_anchor_ms: started,
    last_action_at_ms: started,
    started_at: new Date(started).toISOString(),
    last_action_at: new Date(started).toISOString(),
    cwd: args.cwd || process.cwd(),
    actions: [{ at: nowIso(), action: "session_started" }],
    transcript_session_ids: mergeTranscriptId([], args.transcript_session_id),
    ...checkpointFields(args, started),
  };
}

function startSession(args = {}) {
  const sessions = readSessions();
  const session = buildSession(args);
  sessions[session.id] = session;
  writeSessions(sessions);
  const alias = upsertAlias(args.alias, session.id, args.label);
  return { session, alias, status: sessionStatus(session) };
}

function saveMemory(args = {}) {
  if (!args.summary || typeof args.summary !== "string") {
    throw new Error("save_memory requires a string summary");
  }
  const sessionId =
    args.session_id ||
    (args.alias ? sessionIdForMemoryLookup(args) : "default");
  const title = args.title || `Handoff memory for ${args.alias || sessionId}`;
  const createdAt = nowIso();
  // `slug()` keeps dots (so dotted aliases like `app.v2` round-trip), but in the
  // title portion that lets an embedded extension such as `AGENTS.md` survive and
  // collide with the real `.md` we append, producing names like `...claude.md.md`.
  // Collapse dots to dashes in the title portion only — alias→session_id
  // resolution uses slug() elsewhere and is untouched by this.
  const titleSlug = slug(title)
    .replace(/\./g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const file = `${createdAt.replace(/[:.]/g, "-")}-${slug(sessionId)}-${titleSlug}.md`;
  const target = path.join(MEMORY_DIR, file);
  const tags = Array.isArray(args.tags) ? args.tags : [];
  const body = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `session_id: ${JSON.stringify(sessionId)}`,
    args.alias ? `alias: ${JSON.stringify(args.alias)}` : null,
    `created_at: ${JSON.stringify(createdAt)}`,
    `tags: ${JSON.stringify(tags)}`,
    "---",
    "",
    args.summary.trim(),
    "",
  ]
    .filter(Boolean)
    .join("\n");
  fs.writeFileSync(target, body);
  const alias = upsertAlias(args.alias, sessionId, title);
  return {
    ok: true,
    path: target,
    title,
    session_id: sessionId,
    alias,
    created_at: createdAt,
  };
}

// Compute transcript-usage stats for a tracking session and (as additional
// insight) for the alias's whole lifetime. Bridged to transcripts by time
// window since there is no shared key between cache-manager and the agent log.
function computeSessionStats(args = {}) {
  const { session } = getSession(args, true);
  const now = nowMs();
  const cwd =
    args.all_projects === true
      ? undefined
      : args.cwd || session.cwd || process.cwd();
  const scope = args.scope || "both";

  let aliasStartMs = session.started_at_ms;
  if (args.alias) {
    const record = readAliases()[args.alias];
    const created = record?.created_at ? Date.parse(record.created_at) : NaN;
    if (!Number.isNaN(created)) aliasStartMs = created;
  }

  // Bind usage to the exact chat(s) this tracking session owns. Resolved once
  // over the widest window (alias lifetime) and reused for both scopes; the
  // per-call window then slices time within those chats. An EMPTY set means we
  // found no owning chat (e.g. a legacy session whose chats never called
  // cache-manager) — fall back to undefined so aggregateUsage keeps its
  // unfiltered time+cwd behaviour rather than reporting zero usage.
  let boundSessionIds;
  let attribution = { via: "none", matched: [] };
  if (cwd !== undefined) {
    // Bind by every alias that points at this session, not just args.alias —
    // agents record their cache-manager calls with the ALIAS (never the raw
    // session_id), so a session_id-only stats call must still recover the alias
    // to match what the dashboard (which always has the alias) resolves. Keeps
    // both consumers feeding the resolver identical inputs.
    const aliasNames = new Set();
    if (args.alias) aliasNames.add(args.alias);
    for (const [name, record] of Object.entries(readAliases())) {
      if (record?.session_id === session.id) aliasNames.add(name);
    }
    try {
      const resolved = resolveTranscriptSessionIds({
        cwd,
        windowStartMs: aliasStartMs,
        aliasNames: [...aliasNames],
        trackingSessionIds: [session.id],
        explicitIds: Array.isArray(session.transcript_session_ids)
          ? session.transcript_session_ids
          : [],
      });
      attribution = { via: resolved.via, matched: resolved.matched };
      if (resolved.sessionIds.size > 0) boundSessionIds = resolved.sessionIds;
    } catch {
      boundSessionIds = undefined;
    }
  }

  const payload = {
    ok: true,
    session_id: session.id,
    label: session.label,
    cwd: cwd ?? "(all projects)",
    attribution: {
      via: attribution.via,
      transcript_session_ids: boundSessionIds ? [...boundSessionIds] : [],
      exact: Boolean(boundSessionIds),
    },
  };

  if (scope === "session" || scope === "both") {
    payload.current_session = aggregateUsage({
      windowStartMs: session.started_at_ms,
      windowEndMs: now,
      cwd,
      sessionIds: boundSessionIds,
    });
  }

  if (scope === "alias" || scope === "both") {
    payload.alias_lifetime = aggregateUsage({
      windowStartMs: aliasStartMs,
      windowEndMs: now,
      cwd,
      sessionIds: boundSessionIds,
    });
  }

  // What cache-manager's own MCP tools cost in tokens, priced against whichever
  // window we have, so users can weigh the overhead against the benefit.
  const overheadStats = payload.current_session || payload.alias_lifetime;
  if (overheadStats) {
    try {
      payload.mcp_overhead = computeMcpOverhead({
        tools,
        stats: overheadStats,
        callLog: mcpCallLog,
      });
      payload.mcp_overhead_summary = formatOverhead(payload.mcp_overhead);
    } catch {
      payload.mcp_overhead = null;
    }
  }

  return payload;
}

// Per-call overhead accounting for this server process. Records the byte size
// of the args the model emitted and the result we returned, so session_stats
// can report the per-call token cost actually incurred this lifetime. Resets on
// restart — surfaced as such in the overhead report.
const mcpCallLog = { count: 0, byTool: {} };

function recordMcpCall(name, args, result) {
  const argChars = (() => {
    try {
      return JSON.stringify(args || {}).length;
    } catch {
      return 0;
    }
  })();
  const resultChars = (() => {
    try {
      return JSON.stringify(result || {}).length;
    } catch {
      return 0;
    }
  })();
  mcpCallLog.count += 1;
  const t =
    mcpCallLog.byTool[name] ||
    (mcpCallLog.byTool[name] = { count: 0, argChars: 0, resultChars: 0 });
  t.count += 1;
  t.argChars += argChars;
  t.resultChars += resultChars;
}

function callTool(name, args = {}) {
  if (name === "start_session") {
    const { alias, status } = startSession(args);
    return textResult({ ok: true, alias, status, ...dashboardFields() });
  }

  if (name === "heartbeat") {
    const { sessions, session, id } = getSession(args, true);
    const now = nowMs();
    const iso = new Date(now).toISOString();
    // Capture the prior heartbeat time before overwriting it — used below to
    // detect a stale (abandoned) turn.
    const prevLastActionMs = session.last_action_at_ms;
    session.last_action_at_ms = now;
    session.last_action_at = iso;
    session.ttl_anchor_ms = now;
    if (args.transcript_session_id) {
      session.transcript_session_ids = mergeTranscriptId(
        session.transcript_session_ids,
        args.transcript_session_id,
      );
    }

    // Turn lifecycle. 'start' opens a turn (idempotent — re-starting a turn
    // that is genuinely still live keeps the original start time so the timer
    // reflects total turn duration). 'end' closes it and records last_turn_ms
    // for the post-turn display. 'progress' (default) leaves turn state
    // untouched.
    const phase = args.phase || "progress";
    if (phase === "start") {
      // Only treat an existing running turn as the same turn if it is still
      // live. A turn that went idle (no heartbeats for idle_ms) or outran the
      // max-turn safety valve is a stuck/forgotten phase:"end"; reusing its
      // start time would poison this fresh turn with a wildly inflated
      // elapsed, so open a new turn instead.
      const maxTurnMs = session.turn_max_ms ?? DEFAULT_MAX_TURN_MS;
      const prior = session.turn;
      const stale =
        !prior?.running ||
        now - prevLastActionMs >= session.idle_ms ||
        now - prior.started_at_ms >= maxTurnMs;
      if (stale) {
        session.turn = {
          running: true,
          started_at_ms: now,
          started_at: iso,
          action: args.action || null,
        };
      }
    } else if (phase === "end") {
      if (session.turn?.running) {
        session.last_turn_ms = now - session.turn.started_at_ms;
        session.turn = {
          ...session.turn,
          running: false,
          ended_at_ms: now,
          ended_at: iso,
        };
      }
    }

    session.actions = [
      ...(session.actions || []),
      {
        at: session.last_action_at,
        action: args.action || "heartbeat",
        ...(phase !== "progress" ? { phase } : {}),
      },
    ].slice(-50);
    // Count every heartbeat as a unit of work since the last checkpoint — the
    // protocol is to heartbeat after meaningful steps, so this tracks accrued
    // work for the proactive checkpoint hint. phase:"end" closes a turn, so it
    // is the natural moment for the hint to surface.
    session.actions_since_checkpoint =
      (session.actions_since_checkpoint ?? 0) + 1;
    sessions[id] = session;
    writeSessions(sessions);
    const status = sessionStatus(session);
    const result = { ok: true, status };
    if (status.checkpoint_suggested) {
      result.checkpoint_suggestion = checkpointSuggestion(
        args,
        session,
        status,
      );
    }
    return textResult(result);
  }

  if (name === "status") {
    const { session } = getSession(args, true);
    return textResult(sessionStatus(session));
  }

  if (name === "countdown") {
    const { session } = getSession(args, true);
    return textResult(countdownText(sessionStatus(session)));
  }

  if (name === "handoff_prompt") {
    const { session } = getSession(args, true);
    return textResult({ prompt: handoffPromptText(args, session) });
  }

  if (name === "save_memory") {
    const result = saveMemory(args);
    resetCheckpointCounter(args);
    return textResult(result);
  }

  if (name === "resume_or_start") {
    const lookupSessionId = sessionIdForMemoryLookup(args);
    const memory = latestMemoryForSession(lookupSessionId);
    const { alias, status } = startSession(args);
    return textResult({
      ok: true,
      action: memory
        ? "restored_latest_memory_and_started_session"
        : "started_session_without_memory",
      memory_found: Boolean(memory),
      memory: memory
        ? { found: true, ...memory }
        : { found: false, session_id: lookupSessionId, alias: args.alias },
      alias,
      status,
      ...dashboardFields(),
    });
  }

  if (name === "checkpoint") {
    // Compute usage stats BEFORE saving so they can be appended to the memory.
    let stats = null;
    if (args.include_stats !== false) {
      try {
        stats = computeSessionStats(args);
      } catch {
        stats = null;
      }
    }
    const appendStats = stats && args.append_stats_to_memory !== false;
    const memory = saveMemory(
      appendStats
        ? {
            ...args,
            summary: `${args.summary}\n\n=== USAGE STATS (transcript-derived) ===\n${[
              formatStats("CURRENT SESSION", stats.current_session),
              formatStats("ALIAS LIFETIME", stats.alias_lifetime),
            ]
              .filter(Boolean)
              .join("\n")}`,
          }
        : args,
    );
    const restart = args.restart_session !== false;
    // Carry the existing session's checkpoint-hint thresholds into the fresh
    // session so a custom cadence survives a checkpoint-restart instead of
    // silently reverting to the defaults.
    let prevSession = null;
    try {
      prevSession = getSession(args, false).session;
    } catch {
      prevSession = null;
    }
    const started = restart
      ? startSession({
          checkpoint_after_actions: prevSession?.checkpoint_after_actions,
          checkpoint_after_minutes: prevSession?.checkpoint_after_ms
            ? prevSession.checkpoint_after_ms / 60000
            : undefined,
          ...args,
          label:
            args.label ||
            `Post-checkpoint session for ${args.alias || args.session_id || "default"}`,
        })
      : null;
    // A restart builds a fresh session (counter already 0); otherwise re-arm the
    // proactive checkpoint hint on the existing session.
    if (!restart) resetCheckpointCounter(args);
    return textResult({
      ok: true,
      action: restart ? "saved_memory_and_started_session" : "saved_memory",
      memory,
      stats,
      alias: started?.alias || memory.alias,
      status: started?.status || null,
      restart_prompt: restartPrompt({
        alias: args.alias,
        session_id: memory.session_id,
      }),
      guidance:
        "If this checkpoint was created because TTL expired or a context reset is required, do not continue substantive work in the same agent conversation. Start a fresh MCP client conversation with restart_prompt.",
    });
  }

  if (name === "latest_memory" || name === "list_memories") {
    const sessionId =
      args.session_id ||
      (args.alias ? resolveSessionId({ alias: args.alias }) : undefined);
    const limit =
      name === "latest_memory"
        ? 1
        : Math.max(1, Math.min(100, Number(args.limit || 10)));
    const files = readMemoryEntries()
      .filter((entry) => !sessionId || entry.session_id === sessionId)
      .slice(0, limit);

    if (name === "latest_memory") {
      return textResult(
        files[0]
          ? { found: true, ...files[0] }
          : { found: false, session_id: sessionId, alias: args.alias },
      );
    }
    return textResult({
      memories: files.map(({ content: _content, ...rest }) => rest),
    });
  }

  if (name === "search_memories") {
    if (!args.query || typeof args.query !== "string") {
      throw new Error("search_memories requires a string query");
    }
    const query = args.query.toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(args.limit || 10)));
    const includeContent = Boolean(args.include_content);
    const results = readMemoryEntries()
      .map((entry) => {
        const haystack = [
          entry.title,
          entry.session_id,
          ...(entry.tags || []),
          entry.content,
        ]
          .join("\n")
          .toLowerCase();
        const index = haystack.indexOf(query);
        if (index === -1) return null;
        return {
          ...entry,
          score: entry.title?.toLowerCase().includes(query)
            ? 3
            : entry.tags?.some((tag) => tag.toLowerCase().includes(query))
              ? 2
              : 1,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.mtime_ms - a.mtime_ms)
      .slice(0, limit)
      .map((entry) =>
        includeContent
          ? entry
          : (({ content: _content, ...rest }) => rest)(entry),
      );
    return textResult({ query: args.query, results });
  }

  if (name === "set_alias") {
    const alias = upsertAlias(args.alias, args.session_id, args.title);
    return textResult({ ok: true, alias });
  }

  if (name === "resolve_alias") {
    const aliases = readAliases();
    const alias = aliases[args.alias];
    return textResult(
      alias ? { found: true, alias } : { found: false, alias: args.alias },
    );
  }

  if (name === "list_aliases") {
    return textResult({
      aliases: Object.values(readAliases()).sort((a, b) =>
        String(a.alias).localeCompare(String(b.alias)),
      ),
    });
  }

  if (name === "session_stats") {
    return textResult(computeSessionStats(args));
  }

  if (name === "prune_memories") {
    // The manual tool previews by default; callers opt in to deletion with
    // dry_run:false. (The startup prune calls pruneMemories() directly, so it
    // is unaffected and still deletes for real.)
    return textResult(
      pruneMemories({ ...args, dry_run: args.dry_run ?? true }),
    );
  }

  throw new Error(`unknown tool: ${name}`);
}

let transportMode = null;
let inputBuffer = Buffer.alloc(0);

function send(message) {
  const body = JSON.stringify(message);
  if (transportMode === "line") {
    process.stdout.write(`${body}\n`);
    return;
  }

  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
  );
}

function errorResponse(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function handleRequest(request) {
  const { id, method, params = {} } = request;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "cache-manager", version: "0.1.0" },
          instructions: SERVER_INSTRUCTIONS,
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools } });
      return;
    }

    if (method === "tools/call") {
      const args = params.arguments || {};
      const result = callTool(params.name, args);
      recordMcpCall(params.name, args, result);
      send({ jsonrpc: "2.0", id, result });
      return;
    }

    send(errorResponse(id, `unsupported method: ${method}`));
  } catch (error) {
    send(errorResponse(id, error));
  }
}

function processFramedInput() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = inputBuffer.slice(0, headerEnd).toString("utf8");
    const contentLengthMatch = header.match(
      /(?:^|\r\n)Content-Length: *(\d+)/i,
    );
    if (!contentLengthMatch) {
      send(errorResponse(null, "missing Content-Length header"));
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(contentLengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) return;

    const body = inputBuffer.slice(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(messageEnd);

    try {
      handleRequest(JSON.parse(body));
    } catch (error) {
      send(errorResponse(null, error));
    }
  }
}

function processLineInput() {
  while (true) {
    const newline = inputBuffer.indexOf("\n");
    if (newline === -1) return;

    const line = inputBuffer.slice(0, newline).toString("utf8").trim();
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line) continue;

    try {
      handleRequest(JSON.parse(line));
    } catch (error) {
      send(errorResponse(null, error));
    }
  }
}

if (PRUNE_ON_STARTUP) {
  try {
    const result = pruneMemories();
    if (result.deleted_count > 0) {
      // stderr only: stdout is reserved for the JSON-RPC protocol stream.
      console.error(
        `[cache-manager] pruned ${result.deleted_count} memory file(s) ` +
          `(retention ${RETENTION_DAYS}d, keep_latest_per_alias=${KEEP_LATEST_PER_ALIAS})`,
      );
    }
  } catch (error) {
    console.error(
      `[cache-manager] prune-on-startup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// Web dashboard: launched alongside the MCP server so a live, read-only view is
// available at a localhost URL the agent can surface to the user. On by default;
// disable with CACHE_MANAGER_WEB_DASHBOARD=0. Fully guarded — a dashboard
// failure must never crash or block the MCP server, and it must never write to
// stdout (reserved for the JSON-RPC stream). The resolved URL is held here and
// folded into start_session / resume_or_start responses.
let webDashboardUrl = null;
if (boolEnv("CACHE_MANAGER_WEB_DASHBOARD", true)) {
  try {
    startWebDashboard()
      .then((url) => {
        webDashboardUrl = url;
        if (url) console.error(`[cache-manager] web dashboard at ${url}`);
      })
      .catch((error) => {
        console.error(
          `[cache-manager] web dashboard failed to start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  } catch (error) {
    console.error(
      `[cache-manager] web dashboard failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  if (!transportMode) {
    const trimmed = inputBuffer
      .toString("utf8", 0, Math.min(inputBuffer.length, 32))
      .trimStart();
    transportMode = trimmed.startsWith("Content-Length:") ? "framed" : "line";
  }

  if (transportMode === "framed") {
    processFramedInput();
  } else {
    processLineInput();
  }
});
