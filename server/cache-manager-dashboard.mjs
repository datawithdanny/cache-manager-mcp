#!/usr/bin/env node
// Live terminal dashboard for cache-manager session countdowns. Reads the same
// sessions.json / aliases.json the MCP server writes and renders a refreshing
// table of each tracked session's TTL/idle countdown, plus a per-alias token /
// cost / turn-count running tally. Read-only: it never mutates state. The
// countdown math comes from session-status.mjs and the usage math from
// transcript-stats.mjs, so the dashboard always agrees with what the MCP server
// reports.
import { formatStats } from "./transcript-stats.mjs";
import { buildRows, STORE_DIR } from "./dashboard-data.mjs";

const REFRESH_SECONDS = positiveNumberEnv(
  "CACHE_MANAGER_DASHBOARD_REFRESH_SECONDS",
  1,
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

function color(text, code) {
  if (!IS_TTY || !code) return text;
  return `${code}${text}${RESET}`;
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
