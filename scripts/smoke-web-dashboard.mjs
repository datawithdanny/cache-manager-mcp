#!/usr/bin/env node
// Smoke test for the web dashboard (server/cache-manager-web.mjs). Boots the
// HTTP server against a hermetic store + transcript dir, then asserts the JSON
// API, the HTML page, and the EADDRINUSE "reuse the same URL" behaviour. Env is
// set BEFORE the dynamic import so dashboard-data.mjs picks up the temp store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-manager-web-store-"));
const transcriptDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "cache-manager-web-transcripts-"),
);
// A port well clear of the default (41734) so a real running dashboard can't
// collide with the test.
const PORT = 41987;

process.env.CACHE_MANAGER_STORE_DIR = storeDir;
process.env.CACHE_MANAGER_TRANSCRIPT_DIR = transcriptDir;
process.env.CACHE_MANAGER_DASHBOARD_PORT = String(PORT);
// This suite exercises bind/reuse, not failover — disable the background
// re-bind loop so the reuse test doesn't leave retry timers pending.
process.env.CACHE_MANAGER_DASHBOARD_RETRY_MS = "0";

const now = Date.now();
const sessions = {
  active: {
    id: "active",
    label: "Active session",
    ttl_ms: 300000,
    warn_before_ms: 45000,
    idle_ms: 240000,
    started_at_ms: now - 30000,
    ttl_anchor_ms: now - 30000, // 30s elapsed -> ~4:30 TTL left
    last_action_at_ms: now - 30000,
    started_at: new Date(now - 30000).toISOString(),
    last_action_at: new Date(now - 30000).toISOString(),
    cwd: "/tmp/cache-manager-web-smoke-project", // has cwd -> usage path runs (zeroed)
    actions: [],
  },
  // Two expired sessions: the most recent stays in the main grid, the older one
  // collapses behind "See More". Both are well past their TTL.
  "expired-recent": {
    id: "expired-recent",
    label: "Expired recent",
    ttl_ms: 300000,
    warn_before_ms: 45000,
    idle_ms: 240000,
    started_at_ms: now - 1_000_000,
    ttl_anchor_ms: now - 1_000_000,
    last_action_at_ms: now - 600_000,
    started_at: new Date(now - 1_000_000).toISOString(),
    last_action_at: new Date(now - 600_000).toISOString(),
    cwd: "/tmp/cache-manager-web-smoke-project",
    actions: [],
  },
  "expired-old": {
    id: "expired-old",
    label: "Expired old",
    ttl_ms: 300000,
    warn_before_ms: 45000,
    idle_ms: 240000,
    started_at_ms: now - 5_000_000,
    ttl_anchor_ms: now - 5_000_000,
    last_action_at_ms: now - 4_000_000,
    started_at: new Date(now - 5_000_000).toISOString(),
    last_action_at: new Date(now - 4_000_000).toISOString(),
    cwd: "/tmp/cache-manager-web-smoke-project",
    actions: [],
  },
};
const aliases = {
  "my-thread": {
    alias: "my-thread",
    session_id: "active",
    title: "Active session",
    created_at: new Date(now - 30000).toISOString(),
    updated_at: new Date(now - 30000).toISOString(),
  },
  "old-thread": {
    alias: "old-thread",
    session_id: "expired-old",
    title: "Expired old",
    created_at: new Date(now - 5_000_000).toISOString(),
    updated_at: new Date(now - 5_000_000).toISOString(),
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

// A saved memory for the active thread (matched by frontmatter session_id) so
// the row reports hasMemory:true. The two expired sessions have no memory.
const memoriesDir = path.join(storeDir, "memories");
fs.mkdirSync(memoriesDir, { recursive: true });
fs.writeFileSync(
  path.join(memoriesDir, "2026-01-01T00-00-00-000Z-my-thread-handoff.md"),
  [
    "---",
    'title: "Handoff for my-thread"',
    'session_id: "active"',
    'alias: "my-thread"',
    'created_at: "2026-01-01T00:00:00.000Z"',
    "tags: []",
    "---",
    "Some restart context.",
    "",
  ].join("\n"),
);

const { startWebDashboard } = await import("../server/cache-manager-web.mjs");

const checks = [];
function check(cond, label) {
  checks.push([Boolean(cond), label]);
}

const url = await startWebDashboard();
check(url === `http://127.0.0.1:${PORT}`, "startWebDashboard resolves to the bound URL");

// /api/health
{
  const res = await fetch(`${url}/api/health`);
  const body = await res.json();
  check(res.status === 200 && body.ok === true, "/api/health returns ok");
}

// /api/sessions
{
  const res = await fetch(`${url}/api/sessions`, { cache: "no-store" });
  const body = await res.json();
  check(res.status === 200, "/api/sessions returns 200");
  check(Array.isArray(body.rows) && body.rows.length === 3, "/api/sessions returns three rows");
  check(body.store_dir === storeDir, "/api/sessions reports the store dir");
  const byId = Object.fromEntries(body.rows.map((r) => [r.sessionId, r]));
  const row = byId.active;
  check(row.alias === "my-thread", "row carries the alias");
  check(row.cells && row.cells.alias.includes("my-thread"), "row cells include alias-prefixed name");
  check(typeof row.cells.ttl === "string" && row.cells.ttl.includes("4:30"), "TTL cell reflects ttl_anchor_ms");
  // Has cwd but hermetic (empty) transcripts -> zeroed usage, not the em dash.
  check(row.cells.turns === "0/0", "cwd session shows zeroed turns tally");
  check(row.usage && row.usage.alias, "row carries raw usage object");

  // New: memory presence + restart prompt.
  check(row.hasMemory === true, "active row with a saved memory reports hasMemory:true");
  check(
    typeof row.restartPrompt === "string" &&
      row.restartPrompt.includes("my-thread") &&
      row.restartPrompt.includes("resume_or_start"),
    "row carries an alias-keyed restart prompt",
  );
  check(byId["expired-recent"].hasMemory === false, "expired session without a memory reports hasMemory:false");
  check(byId["expired-recent"].expired === true, "expired-recent row is flagged expired");
  check(byId["expired-old"].expired === true, "expired-old row is flagged expired");
  // restartPrompt falls back to session_id when there is no alias.
  check(
    byId["expired-recent"].restartPrompt.includes("expired-recent"),
    "alias-less row falls back to session_id in restart prompt",
  );
}

// HTML page
{
  const res = await fetch(url);
  const html = await res.text();
  check(res.status === 200, "/ returns 200");
  check(res.headers.get("content-type").includes("text/html"), "/ serves HTML");
  check(html.includes("Cache Manager"), "page includes the title");
  check(html.includes("/api/sessions"), "page polls the JSON endpoint");
  // Banner palette present (pink + green) so the page is themed, not blank.
  check(html.includes("#4f7b66") && html.includes("#f58cbe"), "page uses the banner pink/green palette");
  // Distinct per-state accents are defined (running green, idle amber, near-ttl orange).
  check(html.includes("--run:") && html.includes("--amber:") && html.includes("--orange:"), "page defines distinct per-state accent colours");
  // State legend, See More toggle, copy toast, and click affordance are present.
  check(html.includes('class="legend"'), "page renders a state legend");
  check(html.includes("toggle-expired") && html.includes("See ") , "page wires the expired See More toggle");
  check(html.includes('id="toast"'), "page includes the copy toast element");
  check(html.includes("click to copy restart prompt"), "cards advertise click-to-copy");
  // Cards must be keyed by session id, not display-order index — a positional
  // index aliases the wrong row's restart prompt onto a click when actives and
  // expireds interleave under mixed TTLs. Guard against a regression to data-idx.
  check(html.includes("data-sid=") && !html.includes("data-idx"), "cards are keyed by session id (not positional index)");
}

// 404 for unknown paths
{
  const res = await fetch(`${url}/nope`);
  check(res.status === 404, "unknown path returns 404");
}

// EADDRINUSE: a second instance on the same port reuses the URL instead of failing.
{
  const reused = await startWebDashboard({ port: PORT });
  check(reused === `http://127.0.0.1:${PORT}`, "second instance reuses the URL on EADDRINUSE");
}

// Disabled-port path: an explicit bad port should resolve to null, never throw.
{
  const bad = await startWebDashboard({ port: 70000 });
  check(bad === null, "invalid port resolves to null without throwing");
}

let failed = 0;
for (const [ok, label] of checks) {
  process.stdout.write(`${ok ? "✅" : "❌"} ${label}\n`);
  if (!ok) failed++;
}
process.stdout.write(
  failed === 0
    ? `\nweb-dashboard smoke: all ${checks.length} checks passed\n`
    : `\nweb-dashboard smoke: ${failed}/${checks.length} checks FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
