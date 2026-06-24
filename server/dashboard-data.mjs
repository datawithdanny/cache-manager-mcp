// Shared data layer for the cache-manager dashboards. Both the terminal
// dashboard (cache-manager-dashboard.mjs) and the web dashboard
// (cache-manager-web.mjs) import buildRows() from here so they always agree
// with each other — and, because the usage math comes from transcript-stats.mjs
// and the countdown math from session-status.mjs, with what the MCP server's
// session_stats reports. Read-only: nothing here mutates state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateUsage,
  resolveTranscriptSessionIds,
} from "./transcript-stats.mjs";
import { formatDuration, sessionStatus } from "./session-status.mjs";

const DEFAULT_STORE_DIR = path.join(os.homedir(), ".cache", "cache-manager-mcp");
export const STORE_DIR = process.env.CACHE_MANAGER_STORE_DIR ?? DEFAULT_STORE_DIR;
export const SESSION_FILE = path.join(STORE_DIR, "sessions.json");
export const ALIASES_FILE = path.join(STORE_DIR, "aliases.json");
export const MEMORY_DIR = path.join(STORE_DIR, "memories");

// The exact paste-and-go restart prompt. Lives here (the shared layer both
// dashboards already trust) so the web dashboard's click-to-copy and the MCP
// server's restart_prompt tool output stay byte-identical — editing one can't
// silently drift from the other. Keyed on alias when present, else session_id.
export function buildRestartPrompt({ alias, session_id } = {}) {
  const aliasOrSession = alias
    ? `alias \`${alias}\``
    : `session_id \`${session_id || "default"}\``;
  const resumeArgs = alias
    ? { alias }
    : { session_id: session_id || "default" };
  return [
    "Start a fresh MCP client conversation and paste:",
    "",
    `Resume cache-manager ${aliasOrSession}.`,
    `Before doing anything else, call cache-manager.resume_or_start with ${JSON.stringify(
      {
        ...resumeArgs,
        label: "Resumed from checkpoint",
        ttl_seconds: 300,
        warn_before_seconds: 45,
        idle_seconds: 240,
      },
    )}; read any returned memory content as restart context, then continue with my next goal.`,
  ].join("\n");
}

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Token/cost usage is derived by parsing every in-window transcript, which is
// far too heavy to recompute on every render tick / API poll. Cost doesn't
// change sub-second, so we recompute it on a slower cadence and cache the
// result by session id; callers read the cache on the fast path.
const USAGE_REFRESH_SECONDS = positiveNumberEnv(
  "CACHE_MANAGER_DASHBOARD_USAGE_SECONDS",
  10,
);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// alias name + alias creation time (the anchor for the lifetime usage window),
// keyed by session id. First alias wins for a session id.
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
        // Optional project-group tag. Missing on pre-feature records; readers
        // treat null as "Ungrouped".
        projectGroup: record.project_group ?? null,
      });
    }
  }
  return bySessionId;
}

// Recomputing transcript usage per session is expensive, so cache it by session
// id and only refresh on the slow USAGE cadence. Expired sessions are frozen:
// computed exactly once.
const usageCache = new Map(); // id -> { computedAtMs, frozen, usage }

// Resolve token/cost/turn usage for a session, reusing the cache when fresh.
// Returns null when the session has no stored cwd — without it we can't map to
// the right transcript dir, and falling back to a default cwd would attribute
// unrelated transcript usage to this row. A blank cell is honest.
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
  // the dashboards agree with what the tool reports. For expired sessions we
  // freeze the RESULT (compute once, cache forever via the `frozen` flag), not
  // the window; freezing the window end at expiry would silently diverge from
  // session_stats and read as $0 for a chat that actually cost money.
  const windowEndMs = now;
  const aliasStartMs = aliasCreatedMs ?? session.started_at_ms;

  // Bind to the exact chat(s) this session owns so the row reflects only this
  // chat's spend, not every chat that ran in this project folder. Empty set ⇒
  // fall back to the unfiltered time+cwd behaviour. Mirrors computeSessionStats.
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

// Which sessions/aliases have a saved handoff memory, so a card can offer a
// real restart vs. flag "nothing to restore". We only need the frontmatter
// `session_id`/`alias`, not the body, and we cache the dir scan on the same slow
// cadence as usage because buildRows() runs on every 2s poll. A Set of keys
// (every memory's session_id AND alias) lets a row hit on either.
let memoryKeyCache = { computedAtMs: -Infinity, keys: new Set() };

function pullFrontmatterValue(block, key) {
  // Matches `key: value`, tolerating quotes; frontmatter only, so cheap.
  const match = block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "") || null;
}

function memoryKeys(now) {
  if (now - memoryKeyCache.computedAtMs < USAGE_REFRESH_SECONDS * 1000) {
    return memoryKeyCache.keys;
  }
  const keys = new Set();
  let files;
  try {
    files = fs.readdirSync(MEMORY_DIR);
  } catch {
    files = []; // no memories dir yet -> nothing to restore
  }
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    let head;
    try {
      const content = fs.readFileSync(path.join(MEMORY_DIR, file), "utf8");
      const end = content.indexOf("\n---", 3);
      head = content.startsWith("---") && end !== -1 ? content.slice(0, end) : content;
    } catch {
      continue;
    }
    const sid = pullFrontmatterValue(head, "session_id");
    const alias = pullFrontmatterValue(head, "alias");
    if (sid) keys.add(sid);
    if (alias) keys.add(alias);
  }
  memoryKeyCache = { computedAtMs: now, keys };
  return keys;
}

// Compact token count: 4_382_433 -> "4.4M", 58_408 -> "58.4k", 812 -> "812".
export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

// Sum of every token tier processed in the window — the "usage" headline.
export function totalTokens(stats) {
  if (!stats) return 0;
  return (
    stats.input_tokens +
    stats.output_tokens +
    stats.cache_read_tokens +
    stats.cache_creation_tokens
  );
}

export function formatCost(usd) {
  if (!Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(2)}`;
}

// Build the full set of dashboard rows from the on-disk store. Each row carries
// presentation-neutral fields (severity, raw usage, lastActionMs) plus a
// `cells` object of pre-formatted strings the renderers share. The web layer
// reads both; the terminal layer reads `cells`. This is the single source of
// truth for what either dashboard shows.
export function buildRows() {
  const sessions = readJson(SESSION_FILE, {});
  const aliasBySessionId = aliasInfoBySessionId();
  const now = Date.now();
  const memoryIndex = memoryKeys(now);
  return Object.values(sessions)
    .filter((session) => session?.id)
    .map((session) => {
      const status = sessionStatus(session);
      const aliasInfo = aliasBySessionId.get(session.id);
      const alias = aliasInfo?.alias;
      const label = session.label || session.id;
      const name = alias ? `${alias} (${label})` : label;
      const lastAction = session.last_action_at
        ? session.last_action_at.replace("T", " ").replace(/\.\d+Z$/, "Z")
        : "—";

      // Explicit turn-in-progress state, computed in session-status.mjs (the
      // single source of truth). It self-heals: `running` is false once the
      // session goes idle or expires. While running we suppress the TTL
      // countdown — the cache is being kept warm by the work, so a countdown
      // toward expiry is misleading.
      const running = status.running;

      // Once expired, the live idle counter is meaningless noise that only
      // grows. Freeze it at the value it held the moment the TTL lapsed.
      const ttlAnchorMs = session.ttl_anchor_ms ?? session.started_at_ms;
      const expiresAtMs = ttlAnchorMs + session.ttl_ms;
      const idleMs = status.expired
        ? Math.max(0, expiresAtMs - session.last_action_at_ms)
        : status.idle_for_ms;

      // Turn timer: live elapsed (▶ prefix) while running, last completed
      // turn's duration when idle, em dash when no turn has ever run.
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
      // a transcript dir.
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
      // time-window total and may overlap with other such rows.
      const costCell = usage
        ? `${usage.exact ? "" : "~"}${formatCost(usage.alias.cost?.estimated_usd)}`
        : "—";
      // Savings = what caching avoided: the extra dollars you'd have paid in the
      // hypothetical 90%-cache-miss scenario.
      const savingsCell = usage
        ? formatCost(usage.alias.cost?.hypothetical_high_miss?.extra_usd)
        : "—";

      // Can this card actually restart? True when a saved memory matches the
      // session id or its alias. Drives the copy-vs-flag branch on click.
      const hasMemory =
        memoryIndex.has(session.id) || (alias ? memoryIndex.has(alias) : false);

      return {
        sessionId: session.id,
        alias: alias ?? null,
        // Project-group tag for the alias, or null (rendered as "Ungrouped").
        // Lets the dashboards bucket rows and subtotal cost/savings per group.
        projectGroup: aliasInfo?.projectGroup ?? null,
        label,
        severity: displaySeverity,
        hasMemory,
        // Paste-and-go prompt to resume this thread in a fresh chat. Built from
        // the shared template so it matches the MCP server's restart_prompt.
        restartPrompt: buildRestartPrompt({
          alias: alias ?? undefined,
          session_id: session.id,
        }),
        running,
        expired: status.expired,
        idle: status.idle,
        nearTtl: status.near_ttl,
        checkpointSuggested: status.checkpoint_suggested,
        checkpointReason: status.checkpoint_reason ?? null,
        timeRemainingMs: status.time_remaining_ms,
        turnElapsedMs: status.turn_elapsed_ms,
        idleMs,
        // Raw epoch ms of the last heartbeat, for sorting most-recent first.
        // -Infinity so rows with no recorded action sink to the bottom.
        lastActionMs: Number.isFinite(session.last_action_at_ms)
          ? session.last_action_at_ms
          : -Infinity,
        // Raw usage (current + alias-lifetime stats) for the detail panel; null
        // when the session has no cwd to map to a transcript dir.
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

// Label for rows whose alias carries no project group. Pre-feature aliases.json
// records (and any alias never tagged) fall here.
export const UNGROUPED_LABEL = "Ungrouped";

// Bucket dashboard rows by their alias's project group, preserving each
// bucket's incoming row order. Each bucket carries `cost` and `savings`
// subtotals summed from the alias-lifetime usage of its members — savings is
// the additive `hypothetical_high_miss.extra_usd` already computed per session,
// so a group subtotal is just its members' sum. Rows with a null/missing group
// collect under UNGROUPED_LABEL; missing usage contributes 0. Named groups are
// ordered alphabetically with Ungrouped always last.
export function groupRowsByProject(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = row?.projectGroup || UNGROUPED_LABEL;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const round2 = (n) => Math.round(n * 1e4) / 1e4;
  const groups = [];
  for (const [group, groupRows] of buckets) {
    let cost = 0;
    let savings = 0;
    for (const row of groupRows) {
      const c = row?.usage?.alias?.cost;
      if (!c) continue;
      cost += c.estimated_usd || 0;
      savings += c.hypothetical_high_miss?.extra_usd || 0;
    }
    groups.push({ group, rows: groupRows, cost: round2(cost), savings: round2(savings) });
  }
  return groups.sort((a, b) => {
    if (a.group === UNGROUPED_LABEL) return 1;
    if (b.group === UNGROUPED_LABEL) return -1;
    return a.group.localeCompare(b.group);
  });
}
