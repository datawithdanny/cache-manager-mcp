#!/usr/bin/env node
// Live terminal dashboard for cache-manager session countdowns. Reads the same
// sessions.json / aliases.json the MCP server writes and renders a refreshing
// table of each tracked session's TTL/idle countdown, plus a per-alias token /
// cost / turn-count running tally. Read-only: it never mutates state. The
// countdown math comes from session-status.mjs and the usage math from
// transcript-stats.mjs, so the dashboard always agrees with what the MCP server
// reports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateUsage,
  formatStats,
  resolveTranscriptSessionIds,
} from "./transcript-stats.mjs";
import { formatDuration, sessionStatus } from "./session-status.mjs";

const DEFAULT_STORE_DIR = path.join(os.homedir(), ".cache", "cache-manager-mcp");
const STORE_DIR = process.env.CACHE_MANAGER_STORE_DIR ?? DEFAULT_STORE_DIR;
const SESSION_FILE = path.join(STORE_DIR, "sessions.json");
const ALIASES_FILE = path.join(STORE_DIR, "aliases.json");

const REFRESH_SECONDS = positiveNumberEnv(
  "CACHE_MANAGER_DASHBOARD_REFRESH_SECONDS",
  1,
);
// Token/cost usage is derived by parsing every in-window transcript, which is
// far too heavy to do on the 1s countdown tick (the alias-lifetime window
// reaches back to the alias's creation, so the mtime pre-filter skips almost
// nothing). Cost doesn't change sub-second, so we recompute it on a slower
// cadence and cache the result by session id; the fast render reads the cache.
const USAGE_REFRESH_SECONDS = positiveNumberEnv(
  "CACHE_MANAGER_DASHBOARD_USAGE_SECONDS",
  10,
);
// Terminal width fallback for non-TTY output (piped / --once), where
// process.stdout.columns is undefined. Wide enough to fit the full column set
// (alias + 9 fixed columns) without truncation when redirected to a file.
const FALLBACK_TERM_WIDTH = 160;
const ONCE = process.argv.includes("--once");
const IS_TTY = Boolean(process.stdout.isTTY);

// Detailed usage breakdown panel. Off by default (the table stays the
// at-a-glance view). Enable with `--detail` (CLI) or CACHE_MANAGER_DASHBOARD_DETAIL.
// `--detail=<alias>` (or the env set to an alias) restricts the panel to a single
// alias/label so a busy store stays readable. The panel reuses formatStats — the
// exact renderer the MCP checkpoint summary uses — so the numbers match session_stats.
const DETAIL = parseDetailFlag();

// Returns { enabled, filter } where filter is null (all sessions) or a substring
// to match against the alias/label. CLI `--detail[=x]` wins over the env var.
function parseDetailFlag() {
  const arg = process.argv.find((a) => a === "--detail" || a.startsWith("--detail="));
  if (arg !== undefined) {
    const eq = arg.indexOf("=");
    return { enabled: true, filter: eq === -1 ? null : arg.slice(eq + 1) || null };
  }
  const env = process.env.CACHE_MANAGER_DASHBOARD_DETAIL;
  if (env && env !== "0" && env !== "false") {
    const filter = env === "1" || env === "true" ? null : env;
    return { enabled: true, filter };
  }
  return { enabled: false, filter: null };
}

// Severity -> ANSI color. Only emitted on a TTY; piped output stays plain.
const SEVERITY_COLORS = {
  ok: "\x1b[32m", // green
  running: "\x1b[36m", // cyan
  idle: "\x1b[33m", // yellow
  near_ttl: "\x1b[33m", // yellow
  ttl_and_idle: "\x1b[31m", // red
  expired: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function color(text, code) {
  if (!IS_TTY || !code) return text;
  return `${code}${text}${RESET}`;
}

// alias name + alias creation time (the anchor for the lifetime usage window),
// keyed by session id. First alias wins for a session id, matching the prior
// behaviour.
function aliasInfoBySessionId() {
  const aliases = readJson(ALIASES_FILE, {});
  const bySessionId = new Map();
  for (const record of Object.values(aliases)) {
    if (
      record?.session_id &&
      record?.alias &&
      !bySessionId.has(record.session_id)
    ) {
      const createdMs = record.created_at
        ? Date.parse(record.created_at)
        : NaN;
      bySessionId.set(record.session_id, {
        alias: record.alias,
        createdMs: Number.isNaN(createdMs) ? null : createdMs,
      });
    }
  }
  return bySessionId;
}

// Recomputing transcript usage per session is expensive, so cache it by session
// id and only refresh on the slow USAGE cadence. Expired sessions are frozen:
// their window end is pinned at expiry, so the numbers are static and computed
// exactly once.
const usageCache = new Map(); // id -> { computedAtMs, frozen, usage }

// Resolve token/cost/turn usage for a session, reusing the cache when fresh.
// Returns null when the session has no stored cwd — without it we can't map to
// the right transcript dir, and falling back to the dashboard's own cwd would
// attribute unrelated transcript usage to this row. A blank cell is honest.
function usageForSession(session, status, aliasCreatedMs, now, aliasName) {
  const cwd = session.cwd;
  if (!cwd) return null;

  const frozen = status.expired;
  const cached = usageCache.get(session.id);
  if (cached) {
    if (cached.frozen) return cached.usage;
    if (now - cached.computedAtMs < USAGE_REFRESH_SECONDS * 1000) {
      return cached.usage;
    }
  }

  // Window always ends at "now" — same as the MCP server's session_stats — so
  // the dashboard agrees with what the tool reports. For expired sessions we
  // freeze the RESULT (compute once, cache forever via the `frozen` flag), not
  // the window; freezing the window end at expiry would silently diverge from
  // session_stats and read as $0 for a chat that actually cost money.
  const windowEndMs = now;
  const aliasStartMs = aliasCreatedMs ?? session.started_at_ms;

  // Bind to the exact chat(s) this session owns so the row reflects only this
  // chat's spend, not every chat that ran in this project folder. Empty set ⇒
  // fall back to the unfiltered time+cwd behaviour (legacy/unattributable rows
  // still render real numbers rather than $0). Mirrors computeSessionStats.
  let boundSessionIds;
  let attributionExact = false;
  try {
    const resolved = resolveTranscriptSessionIds({
      cwd,
      windowStartMs: aliasStartMs,
      aliasNames: aliasName ? [aliasName] : [],
      trackingSessionIds: [session.id],
      explicitIds: Array.isArray(session.transcript_session_ids)
        ? session.transcript_session_ids
        : [],
    });
    if (resolved.sessionIds.size > 0) {
      boundSessionIds = resolved.sessionIds;
      attributionExact = true;
    }
  } catch {
    boundSessionIds = undefined;
  }

  let usage;
  try {
    usage = {
      current: aggregateUsage({
        windowStartMs: session.started_at_ms,
        windowEndMs,
        cwd,
        sessionIds: boundSessionIds,
      }),
      alias: aggregateUsage({
        windowStartMs: aliasStartMs,
        windowEndMs,
        cwd,
        sessionIds: boundSessionIds,
      }),
      exact: attributionExact,
    };
  } catch {
    usage = null;
  }

  usageCache.set(session.id, { computedAtMs: now, frozen, usage });
  return usage;
}

function pad(text, width) {
  const value = String(text ?? "");
  if (value.length === width) return value;
  if (value.length > width) {
    // Truncate with an ellipsis so a clipped name reads as clipped rather than
    // as a different (shorter) name. Width 1 has no room for the marker.
    return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
  }
  return value + " ".repeat(width - value.length);
}

// Compact token count: 4_382_433 -> "4.4M", 58_408 -> "58.4k", 812 -> "812".
function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Sum of every token tier processed in the window — the "usage" headline.
function totalTokens(stats) {
  if (!stats) return 0;
  return (
    stats.input_tokens +
    stats.output_tokens +
    stats.cache_read_tokens +
    stats.cache_creation_tokens
  );
}

function formatCost(usd) {
  if (!Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(2)}`;
}

// The non-alias columns are fixed width; the alias/label column flexes to fill
// whatever horizontal space is left (see computeAliasWidth).
const FIXED_COLUMNS = [
  { key: "ttl", label: "TTL LEFT", width: 9 },
  { key: "turn", label: "TURN", width: 10 },
  { key: "idle", label: "IDLE", width: 8 },
  { key: "turns", label: "TURNS", width: 9 },
  { key: "tokens", label: "TOKENS", width: 8 },
  { key: "cost", label: "COST", width: 9 },
  { key: "savings", label: "SAVINGS", width: 9 },
  { key: "severity", label: "SEVERITY", width: 12 },
  { key: "last", label: "LAST ACTION", width: 20 },
];
const COL_GAP = "  ";
const ALIAS_MIN_WIDTH = 14; // >= "ALIAS / LABEL" so the header never truncates
const ALIAS_MAX_WIDTH = 60;

// Size the alias/label column to the longest name, but never past the space
// left over after the fixed columns and gaps — so the table fills the terminal
// without wrapping. Names longer than the final width are ellipsised by pad().
function computeAliasWidth(rows) {
  const termWidth =
    (IS_TTY && process.stdout.columns) || FALLBACK_TERM_WIDTH;
  const fixed =
    FIXED_COLUMNS.reduce((sum, c) => sum + c.width, 0) +
    COL_GAP.length * FIXED_COLUMNS.length; // one gap before each fixed column
  const available = termWidth - fixed;
  const longest = rows.reduce(
    (max, row) => Math.max(max, String(row.cells.alias ?? "").length),
    "ALIAS / LABEL".length,
  );
  const desired = Math.min(longest, ALIAS_MAX_WIDTH);
  return Math.max(ALIAS_MIN_WIDTH, Math.min(desired, available));
}

// Assemble the full ordered column list once the flexible alias width is known.
function columnsFor(aliasWidth) {
  return [{ key: "alias", label: "ALIAS / LABEL", width: aliasWidth }, ...FIXED_COLUMNS];
}

function buildRows() {
  const sessions = readJson(SESSION_FILE, {});
  const aliasBySessionId = aliasInfoBySessionId();
  const now = Date.now();
  return Object.values(sessions)
    .filter((session) => session?.id)
    .map((session) => {
      const status = sessionStatus(session);
      const aliasInfo = aliasBySessionId.get(session.id);
      const alias = aliasInfo?.alias;
      const name = alias
        ? `${alias} (${session.label || session.id})`
        : session.label || session.id;
      const lastAction = session.last_action_at
        ? session.last_action_at.replace("T", " ").replace(/\.\d+Z$/, "Z")
        : "—";

      // Explicit turn-in-progress state, computed in session-status.mjs (the
      // single source of truth). It already self-heals: `running` is false once
      // the session goes idle or expires, so a forgotten phase:"end" can't pin
      // the badge on forever. While running we suppress the TTL countdown — the
      // cache is being kept warm by the work, so a countdown toward expiry is
      // misleading.
      const running = status.running;

      // Once expired, the live idle counter is meaningless noise that only
      // grows. Freeze it at the value it held the moment the TTL lapsed
      // (expiry time minus the last heartbeat), so it stops updating.
      const ttlAnchorMs = session.ttl_anchor_ms ?? session.started_at_ms;
      const expiresAtMs = ttlAnchorMs + session.ttl_ms;
      const idleMs = status.expired
        ? Math.max(0, expiresAtMs - session.last_action_at_ms)
        : status.idle_for_ms;

      // Turn timer: live elapsed (▶ prefix) while running, last completed
      // turn's duration when idle, em dash when no turn has ever run. No
      // per-cell coloring — pad() counts raw chars, so an ANSI-wrapped cell
      // would misalign the column; the whole row is colored by severity later.
      const turnCell =
        status.turn_elapsed_ms == null
          ? "—"
          : running
            ? `▶ ${formatDuration(status.turn_elapsed_ms)}`
            : formatDuration(status.turn_elapsed_ms);

      const displaySeverity = running ? "running" : status.severity;

      // Token/cost/turn tallies derived from transcripts (cached on a slow
      // cadence). `current` is this chat's window; `alias` is the running tally
      // since the alias was created. Null when the session has no cwd to map to
      // a transcript dir — those cells render as "—".
      const usage = usageForSession(
        session,
        status,
        aliasInfo?.createdMs,
        now,
        alias,
      );
      const turnsCell = usage
        ? `${usage.current.turns}/${usage.alias.turns}`
        : "—";
      const tokensCell = usage ? formatTokens(totalTokens(usage.alias)) : "—";
      // A leading "~" flags a row we couldn't bind to a specific chat (no
      // recorded cache-manager call) — its cost is the project's full
      // time-window total and may overlap with other such rows. Bound rows are
      // exact and unmarked. See the footnote.
      const costCell = usage
        ? `${usage.exact ? "" : "~"}${formatCost(usage.alias.cost?.estimated_usd)}`
        : "—";
      // Savings = what caching avoided: the extra dollars you'd have paid in the
      // hypothetical 90%-cache-miss scenario (transcript-stats computes this as
      // hypothetical_high_miss.extra_usd, holding everything else constant).
      const savingsCell = usage
        ? formatCost(usage.alias.cost?.hypothetical_high_miss?.extra_usd)
        : "—";

      return {
        severity: displaySeverity,
        checkpointSuggested: status.checkpoint_suggested,
        // Raw epoch ms of the last heartbeat, for sorting the table most-recent
        // first. Falls back to -Infinity so rows with no recorded action sink
        // to the bottom rather than jumping ahead of real activity.
        lastActionMs: Number.isFinite(session.last_action_at_ms)
          ? session.last_action_at_ms
          : -Infinity,
        // Raw usage (current + alias-lifetime stats) for the optional detail
        // panel; null when the session has no cwd to map to a transcript dir.
        usage,
        cells: {
          alias: name,
          ttl: running ? "▶ running" : formatDuration(status.time_remaining_ms),
          turn: turnCell,
          idle: formatDuration(idleMs),
          turns: turnsCell,
          tokens: tokensCell,
          cost: costCell,
          savings: savingsCell,
          severity: displaySeverity,
          last: lastAction,
        },
      };
    })
    // Most recent activity first; ties (incl. no-action rows) fall back to alias
    // order so the ordering stays stable across refreshes.
    .sort(
      (a, b) =>
        b.lastActionMs - a.lastActionMs ||
        a.cells.alias.localeCompare(b.cells.alias),
    );
}

// Full per-session usage breakdown, identical in detail to the MCP checkpoint
// summary. Appends, for each row that has usage (optionally filtered to one
// alias), the formatStats blocks for this chat's window and the alias lifetime.
function detailLines(rows) {
  const lines = [];
  const matched = rows.filter((row) => {
    if (!row.usage) return false;
    if (!DETAIL.filter) return true;
    return row.cells.alias.includes(DETAIL.filter);
  });

  lines.push("");
  lines.push(color("USAGE DETAIL", BOLD));
  if (DETAIL.filter) {
    lines.push(color(`filter: alias/label contains "${DETAIL.filter}"`, DIM));
  }

  if (matched.length === 0) {
    lines.push(
      color(
        DETAIL.filter
          ? "No tracked session with usage matches the filter."
          : "No tracked session has transcript usage to detail.",
        DIM,
      ),
    );
    return lines;
  }

  for (const row of matched) {
    lines.push("");
    lines.push(color(`▸ ${row.cells.alias}`, BOLD));
    lines.push(color(formatStats("current session", row.usage.current), DIM));
    lines.push(color(formatStats("alias lifetime", row.usage.alias), DIM));
  }
  return lines;
}

function render() {
  const rows = buildRows();
  const lines = [];

  const title = "⏳ Cache Manager — Countdown Dashboard";
  lines.push(color(title, BOLD));
  lines.push(
    color(
      `store: ${STORE_DIR}  ·  refresh: ${REFRESH_SECONDS}s  ·  ${new Date()
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "Z")}`,
      DIM,
    ),
  );
  lines.push("");

  if (rows.length === 0) {
    lines.push(color("No tracked sessions yet.", DIM));
    lines.push(
      color(
        "Start one via cache-manager.resume_or_start or start_session.",
        DIM,
      ),
    );
  } else {
    const columns = columnsFor(computeAliasWidth(rows));
    const header = columns.map((c) => pad(c.label, c.width)).join(COL_GAP);
    lines.push(color(header, BOLD));
    lines.push(color("─".repeat(header.length), DIM));

    for (const row of rows) {
      const code = SEVERITY_COLORS[row.severity] ?? "";
      const line = columns
        .map((c) => pad(row.cells[c.key], c.width))
        .join(COL_GAP);
      lines.push(color(line, code));
    }

    const counts = rows.reduce((acc, row) => {
      acc[row.severity] = (acc[row.severity] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(counts)
      .map(([severity, n]) => `${severity}:${n}`)
      .join("  ");
    const checkpointDue = rows.filter((row) => row.checkpointSuggested).length;
    lines.push("");
    lines.push(
      color(
        `${rows.length} session(s)  ·  ${summary}${
          checkpointDue ? `  ·  checkpoint-due:${checkpointDue}` : ""
        }`,
        DIM,
      ),
    );
    lines.push(
      color(
        "TTL counts from last activity — permission prompts and idle time age the cache too.",
        DIM,
      ),
    );
    const inexact = rows.filter((row) => row.usage && !row.usage.exact).length;
    lines.push(
      color(
        "TURNS = this chat / alias lifetime; TOKENS, COST & SAVINGS are the alias tally (since the alias was created), attributed to the exact chat(s) bound to this session. SAVINGS = extra cost avoided by caching vs a 90% cache-miss.",
        DIM,
      ),
    );
    if (inexact > 0) {
      lines.push(
        color(
          `${inexact} row(s) marked ~ couldn't be bound to a specific chat (no recorded cache-manager call) — those fall back to this project's full time-window total and may overlap.`,
          DIM,
        ),
      );
    }
    if (!DETAIL.enabled) {
      lines.push(
        color(
          "Run with --detail (or --detail=<alias>) for the full token/cost breakdown.",
          DIM,
        ),
      );
    }
  }

  if (DETAIL.enabled && rows.length > 0) {
    lines.push(...detailLines(rows));
  }

  const output = lines.join("\n");
  if (IS_TTY && !ONCE) {
    // Clear screen + home cursor, then redraw.
    process.stdout.write(`\x1b[2J\x1b[H${output}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }
}

function main() {
  if (ONCE) {
    render();
    return;
  }

  if (IS_TTY) process.stdout.write("\x1b[?25l"); // hide cursor
  const cleanup = () => {
    if (IS_TTY) process.stdout.write("\x1b[?25h\n"); // restore cursor
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  render();
  setInterval(render, REFRESH_SECONDS * 1000);
}

main();
