#!/usr/bin/env node
// Web dashboard for cache-manager. A tiny, dependency-free HTTP server that
// serves a single auto-refreshing page (pink + green, matching the banner) plus
// a JSON endpoint. Read-only: it only reads the same sessions.json / aliases.json
// the MCP server writes, via the shared buildRows() in dashboard-data.mjs, so it
// always agrees with the terminal dashboard and the MCP server's session_stats.
//
// It is launched automatically by the MCP server (cache-manager.mjs) on startup,
// and can also be run standalone (`cache-manager-dashboard --web` / the
// `dashboard:web` npm script). Because every MCP client spawns its own server
// but they all share one store, the first process to bind the port serves every
// session; the rest hit EADDRINUSE and simply reuse the same URL. Binds
// 127.0.0.1 only — a local dev tool, never exposed to the network.
import http from "node:http";
import { buildRows, STORE_DIR } from "./dashboard-data.mjs";

const DEFAULT_PORT = 41734;
const DEFAULT_HOST = "127.0.0.1";
// How often a non-owning instance re-attempts the bind so it can take over the
// dashboard if the current owner exits and frees the port. 0 disables failover.
const DEFAULT_RETRY_MS = 3000;

function portFromEnv() {
  const raw = Number(process.env.CACHE_MANAGER_DASHBOARD_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT;
}

function retryMsFromEnv() {
  const raw = Number(process.env.CACHE_MANAGER_DASHBOARD_RETRY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRY_MS;
}

// stderr-only: stdout is reserved for the MCP JSON-RPC stream, and this module
// is imported into that process. Never console.log here.
function logErr(message) {
  try {
    console.error(`[cache-manager:web] ${message}`);
  } catch {
    /* logging is best-effort */
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sessionsPayload() {
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    store_dir: STORE_DIR,
    rows: buildRows(),
  };
}

function handleRequest(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (url.pathname === "/api/sessions") {
      sendJson(res, 200, sessionsPayload());
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, store_dir: STORE_DIR });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(PAGE_HTML);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    // A failed request must never take down the server (or, by extension, the
    // MCP process hosting it).
    logErr(`request error: ${error instanceof Error ? error.message : error}`);
    try {
      sendJson(res, 500, { ok: false, error: "internal error" });
    } catch {
      /* response may already be partially sent */
    }
  }
}

// Start the web dashboard. Resolves to the dashboard URL (string), or null if
// the dashboard is disabled / could not start. Never rejects: a dashboard
// failure must not break the MCP server.
//
// Failover: every MCP client spawns its own server process, but only the first
// to bind the port serves HTTP. On EADDRINUSE we resolve immediately with the
// (shared) URL so the link is surfaced right away, AND keep re-attempting the
// bind in the background every `retryMs`. When the current owner exits and frees
// the port, the next retry succeeds and this process transparently takes over —
// so the dashboard survives as long as ANY tracked chat is alive, not just the
// one that happened to boot first. Retries are unref'd (never hold the process
// open) and stop the moment a bind succeeds. retryMs:0 disables failover.
export function startWebDashboard({
  port = portFromEnv(),
  host = DEFAULT_HOST,
  retryMs = retryMsFromEnv(),
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let bound = false;
    let retryTimer = null;
    const url = `http://${host}:${port}`;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let server;
    try {
      server = http.createServer(handleRequest);
    } catch (error) {
      logErr(`could not create server: ${error instanceof Error ? error.message : error}`);
      finish(null);
      return;
    }

    server.on("listening", () => {
      bound = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // Don't let the dashboard keep the process alive on its own.
      server.unref();
      // First-boot bind vs. a later takeover after the owner freed the port.
      logErr(settled ? `took over dashboard at ${url}` : `dashboard listening at ${url}`);
      finish(url);
    });

    server.on("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        // Another instance owns the port (it serves the same shared store).
        // Surface its URL now, then keep retrying so we take over if it exits.
        if (!settled) logErr(`port ${port} already in use — reusing existing dashboard`);
        finish(url);
        if (retryMs > 0 && !bound) {
          retryTimer = setTimeout(tryListen, retryMs);
          if (retryTimer.unref) retryTimer.unref();
        }
        return;
      }
      logErr(`server error: ${error instanceof Error ? error.message : error}`);
      finish(null);
    });

    // Attempt the bind. listen() can throw synchronously (e.g. an out-of-range
    // port) — guard it so a bad config resolves to null rather than surfacing as
    // an unhandled rejection in the MCP process. Re-callable: on EADDRINUSE the
    // error handler reschedules this for the failover loop.
    function tryListen() {
      try {
        server.listen(port, host);
      } catch (error) {
        logErr(`could not listen on ${host}:${port}: ${error instanceof Error ? error.message : error}`);
        finish(null);
      }
    }
    tryListen();
  });
}

// Single-page app: minimalist, pink + green to match the banner. Polls
// /api/sessions and renders a card per tracked session. No build step, no deps.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cache Manager — Dashboard</title>
<style>
  :root {
    --bg-1: #edf2ee; --bg-2: #dde7df;
    --green: #4f7b66; --green-soft: #5d8a73; --green-muted: #6f8579;
    --ink: #33415c;
    --pink: #f58cbe; --pink-soft: #ff9bc9; --pink-tint: #ffd9ec;
    --gold: #f5b942;
    --card: #ffffff; --stroke: #cdd8d0;
    --danger: #c96b8a;
    /* Per-state accents — each status gets its own colour so the grid is
       readable at a glance. Running is a brighter green, distinct from the
       resting "ok" green; idle/near-ttl escalate amber -> orange. */
    --run: #16a35a; --run-tint: #e1f5ea;
    --amber: #e0a213; --amber-ink: #5a3d00;
    --orange: #e0701f; --orange-ink: #5a2c00;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: 'Trebuchet MS', 'Segoe UI', system-ui, sans-serif;
    color: var(--ink);
    background: linear-gradient(135deg, var(--bg-1), var(--bg-2));
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 22px 60px; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .pig {
    width: 46px; height: 46px; border-radius: 50%;
    background: linear-gradient(180deg, #ffc1de, #ff9bc9);
    display: grid; place-items: center; font-size: 24px;
    box-shadow: 0 3px 8px rgba(90,119,102,0.22);
    flex: none;
  }
  h1 { margin: 0; font-size: 26px; color: var(--green); font-weight: 700; letter-spacing: .2px; }
  .badge-mcp {
    background: var(--green-soft); color: #f0f4f0; font-weight: 700;
    border-radius: 9px; padding: 4px 10px; font-size: 13px; letter-spacing: .4px;
  }
  .tag { margin: 6px 0 0; color: var(--green-muted); font-size: 14px; }
  .meta {
    margin-left: auto; text-align: right; color: var(--green-muted);
    font-size: 12px; line-height: 1.5;
  }
  .meta .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--pink); margin-right: 6px; vertical-align: middle;
    animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:1} }

  .summary { display: flex; gap: 12px; flex-wrap: wrap; margin: 22px 0 10px; }
  .stat {
    background: var(--card); border: 1.5px solid var(--stroke); border-radius: 14px;
    padding: 12px 16px; min-width: 120px; box-shadow: 0 2px 6px rgba(90,119,102,0.08);
  }
  .stat .k { font-size: 12px; color: var(--green-muted); text-transform: uppercase; letter-spacing: .5px; }
  .stat .v { font-size: 22px; font-weight: 700; color: var(--green); margin-top: 2px; }
  .stat.pink .v { color: var(--pink); }
  .stat.run .v { color: var(--run); }
  .stat.gold .v { color: #c98a13; }

  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); margin-top: 14px; }
  .card {
    background: var(--card); border: 1.5px solid var(--stroke); border-radius: 16px;
    padding: 16px 18px; box-shadow: 0 2px 8px rgba(90,119,102,0.10);
    border-left: 5px solid var(--green-soft);
    transition: transform .12s ease, box-shadow .12s ease;
    cursor: pointer;
  }
  .card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(90,119,102,0.18); }
  .card::after {
    content: "⧉ click to copy restart prompt"; display: block; margin-top: 11px;
    font-size: 10.5px; letter-spacing: .3px; color: var(--green-muted); opacity: .6;
  }
  .card.no-mem::after { content: "⊘ no saved memory — can't restart"; color: var(--danger); opacity: .7; }
  .card.running { border-left-color: var(--run); background: linear-gradient(180deg, var(--run-tint), #fff 60%); }
  .card.idle { border-left-color: var(--amber); }
  .card.near_ttl { border-left-color: var(--orange); }
  .card.expired, .card.ttl_and_idle { border-left-color: var(--danger); opacity: .82; }

  .card .top { display: flex; align-items: flex-start; gap: 10px; }
  .card .name { font-weight: 700; font-size: 15px; color: var(--ink); word-break: break-word; }
  .card .sub { font-size: 12px; color: var(--green-muted); margin-top: 2px; word-break: break-word; }
  .pill {
    margin-left: auto; flex: none; font-size: 11px; font-weight: 700; letter-spacing: .4px;
    text-transform: uppercase; padding: 4px 9px; border-radius: 999px;
    color: #fff; background: var(--green-soft);
  }
  .pill.running { background: var(--run); animation: pulse 1.6s ease-in-out infinite; }
  .pill.idle { background: var(--amber); color: var(--amber-ink); }
  .pill.near_ttl { background: var(--orange); color: var(--orange-ink); }
  .pill.expired, .pill.ttl_and_idle { background: var(--danger); }
  .pill.running::before { content: "▶ "; }

  /* State legend — makes the colour vocabulary explicit. */
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 4px 0 0; font-size: 12px; color: var(--green-muted); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  .legend .l-ok { background: var(--green-soft); }
  .legend .l-running { background: var(--run); }
  .legend .l-idle { background: var(--amber); }
  .legend .l-near { background: var(--orange); }
  .legend .l-expired { background: var(--danger); }

  /* See-more section for collapsed expired aliases. */
  .seemore { margin-top: 22px; }
  .seemore button {
    font: inherit; font-size: 13px; font-weight: 700; color: var(--green);
    background: var(--card); border: 1.5px solid var(--stroke); border-radius: 999px;
    padding: 7px 16px; cursor: pointer; transition: background .12s ease;
  }
  .seemore button:hover { background: #f4f8f4; }
  .seemore .grid { margin-top: 14px; }

  /* Copy toast. */
  #toast {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(20px);
    background: var(--ink); color: #fff; font-size: 13px; font-weight: 600;
    padding: 11px 18px; border-radius: 12px; box-shadow: 0 6px 20px rgba(0,0,0,.22);
    opacity: 0; pointer-events: none; transition: opacity .2s ease, transform .2s ease; z-index: 50;
    max-width: 90vw;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.warn { background: var(--danger); }

  .rows { margin-top: 13px; display: grid; grid-template-columns: 1fr 1fr; gap: 9px 14px; }
  .kv .k { font-size: 11px; color: var(--green-muted); text-transform: uppercase; letter-spacing: .4px; }
  .kv .val { font-size: 15px; font-weight: 600; color: var(--ink); margin-top: 1px; }
  .kv .val.green { color: var(--green); }
  .kv .val.pink { color: var(--pink); }
  .kv .val.run { color: var(--run); }
  .kv .val.gold { color: #c98a13; }
  .ckpt { margin-top: 12px; font-size: 12px; color: #8a6410; background: #fff7e6;
    border: 1px solid #ffe2a8; border-radius: 9px; padding: 7px 10px; }
  .last { margin-top: 11px; font-size: 11px; color: var(--green-muted); }

  .empty, .err { text-align: center; color: var(--green-muted); margin-top: 60px; font-size: 15px; }
  .err { color: var(--danger); }
  footer { margin-top: 34px; text-align: center; color: var(--green-muted); font-size: 12px; line-height: 1.6; }
  code { background: #eef3ee; padding: 1px 6px; border-radius: 6px; color: var(--green); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="pig">🐷</div>
    <div>
      <h1>Cache Manager <span class="badge-mcp">MCP</span></h1>
      <p class="tag">Keep your context cute and your cache warm.</p>
    </div>
    <div class="meta">
      <div><span class="dot"></span><span id="status">connecting…</span></div>
      <div id="store"></div>
    </div>
  </header>

  <div class="summary" id="summary"></div>
  <div class="legend">
    <span><i class="l-ok"></i>ok</span>
    <span><i class="l-running"></i>running</span>
    <span><i class="l-idle"></i>idle</span>
    <span><i class="l-near"></i>near ttl</span>
    <span><i class="l-expired"></i>expired</span>
  </div>
  <div id="content"><p class="empty">Loading sessions…</p></div>

  <footer>
    Live, read-only view of every tracked chat. TTL counts from last activity.
    TOKENS / COST / SAVINGS are the alias lifetime tally; SAVINGS = extra cost avoided by caching vs a 90% cache-miss.<br/>
    Refreshes automatically. Disable with <code>CACHE_MANAGER_WEB_DASHBOARD=0</code> · change port with <code>CACHE_MANAGER_DASHBOARD_PORT</code>.
  </footer>
</div>
<div id="toast" role="status" aria-live="polite"></div>

<script>
const REFRESH_MS = 2000;
const SEV_LABEL = { ok: "ok", running: "running", idle: "idle", near_ttl: "near ttl", ttl_and_idle: "expired", expired: "expired" };

// Current rows keyed by session id so a card's click handler can read its
// restartPrompt / hasMemory without serialising a multi-line prompt into DOM
// attributes. Keyed (not indexed) so display-order partitioning can never alias
// one card's click onto another row.
let ROWS = {};
// Persist whether the "See More" expired section is open across refreshes.
let showExpired = false;

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
function costClass(v) { return (v && v !== "—" && v !== "$0.00" && v !== "~$0.00") ? "green" : ""; }

function card(r) {
  const sev = r.severity || "ok";
  const c = r.cells || {};
  const sub = r.alias ? esc(r.label) : "";
  const name = r.alias ? esc(r.alias) : esc(r.label);
  const ckpt = r.checkpointSuggested
    ? '<div class="ckpt">⛳ Checkpoint suggested' + (r.checkpointReason ? ': ' + esc(r.checkpointReason) : '') + '</div>'
    : '';
  const memClass = r.hasMemory ? '' : ' no-mem';
  const title = r.hasMemory ? 'Click to copy a restart prompt for this chat' : 'No saved memory — nothing to restart from';
  return '<div class="card ' + sev + memClass + '" data-sid="' + esc(r.sessionId) + '" tabindex="0" role="button" title="' + esc(title) + '">'
    + '<div class="top"><div><div class="name">' + name + '</div>'
    + (sub ? '<div class="sub">' + sub + '</div>' : '')
    + '</div><span class="pill ' + sev + '">' + (SEV_LABEL[sev] || sev) + '</span></div>'
    + '<div class="rows">'
    + kv('TTL left', c.ttl, r.running ? 'run' : '')
    + kv('Turn', c.turn, r.running ? 'run' : '')
    + kv('Idle', c.idle, '')
    + kv('Turns', c.turns, 'green')
    + kv('Tokens', c.tokens, 'green')
    + kv('Cost', c.cost, costClass(c.cost))
    + kv('Savings', c.savings, 'gold')
    + kv('Severity', SEV_LABEL[sev] || sev, '')
    + '</div>'
    + ckpt
    + '<div class="last">last activity · ' + esc(c.last) + '</div>'
    + '</div>';
}
function kv(k, v, cls) {
  return '<div class="kv"><div class="k">' + k + '</div><div class="val ' + (cls||'') + '">' + esc(v == null ? '—' : v) + '</div></div>';
}
function grid(rows) {
  return '<div class="grid">' + rows.map(card).join('') + '</div>';
}

function summary(rows) {
  const n = rows.length;
  const running = rows.filter(r => r.running).length;
  const active = rows.filter(r => !r.expired).length;
  const cost = rows.reduce((s, r) => s + (r.usage && r.usage.alias && r.usage.alias.cost ? (r.usage.alias.cost.estimated_usd || 0) : 0), 0);
  const saved = rows.reduce((s, r) => s + (r.usage && r.usage.alias && r.usage.alias.cost && r.usage.alias.cost.hypothetical_high_miss ? (r.usage.alias.cost.hypothetical_high_miss.extra_usd || 0) : 0), 0);
  return [
    stat('Sessions', n),
    stat('Active', active),
    stat('Running', running, 'run'),
    stat('Total cost', '$' + cost.toFixed(2)),
    stat('Saved by cache', '$' + saved.toFixed(2), 'gold'),
  ].join('');
}
function stat(k, v, cls) {
  return '<div class="stat ' + (cls||'') + '"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>';
}

let toastTimer = null;
function toast(message, warn) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'show' + (warn ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

async function onCardActivate(sid) {
  const r = ROWS[sid];
  if (!r) return;
  if (!r.hasMemory) {
    toast('No saved memory for "' + (r.alias || r.label) + '" — can\\'t restart this chat.', true);
    return;
  }
  const ok = await copyText(r.restartPrompt || '');
  toast(ok ? 'Copied restart prompt for "' + (r.alias || r.label) + '"' : 'Copy failed — select the card text manually.', !ok);
}

// Render once; partition expired aliases behind a See More toggle, keeping only
// the single most-recent expired in the main grid. Rows arrive sorted
// recent-first from the server, so the first expired IS the most recent.
function render(rows) {
  ROWS = {};
  for (const r of rows) ROWS[r.sessionId] = r;
  const active = rows.filter(r => !r.expired);
  const expired = rows.filter(r => r.expired);
  const mainExpired = expired.slice(0, 1);     // keep the most recent expired
  const hidden = expired.slice(1);             // the rest collapse
  const main = active.concat(mainExpired);

  let html = grid(main);
  if (hidden.length) {
    const label = showExpired
      ? 'Hide ' + hidden.length + ' older expired'
      : 'See ' + hidden.length + ' more expired';
    html += '<div class="seemore"><button id="toggle-expired">' + label + '</button>'
      + (showExpired ? grid(hidden) : '')
      + '</div>';
  }
  document.getElementById('content').innerHTML = html;
}

async function tick() {
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const rows = data.rows || [];
    document.getElementById('status').textContent = 'live · ' + new Date(data.generated_at).toLocaleTimeString();
    document.getElementById('store').textContent = data.store_dir || '';
    document.getElementById('summary').innerHTML = rows.length ? summary(rows) : '';
    if (rows.length) render(rows);
    else { ROWS = {}; document.getElementById('content').innerHTML = '<p class="empty">No tracked sessions yet. Start one via <code>resume_or_start</code>.</p>'; }
  } catch (e) {
    document.getElementById('status').textContent = 'disconnected';
    document.getElementById('content').innerHTML = '<p class="err">Could not reach the dashboard API (' + esc(e.message) + '). Retrying…</p>';
  }
}

// Delegated handlers: cards and the See More toggle are re-rendered every tick.
document.getElementById('content').addEventListener('click', (e) => {
  if (e.target.closest('#toggle-expired')) { showExpired = !showExpired; tick(); return; }
  const card = e.target.closest('.card[data-sid]');
  if (card) onCardActivate(card.getAttribute('data-sid'));
});
document.getElementById('content').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.card[data-sid]');
  if (card) { e.preventDefault(); onCardActivate(card.getAttribute('data-sid')); }
});

tick();
setInterval(tick, REFRESH_MS);
</script>
</body>
</html>`;

// Standalone entry point: `node cache-manager-web.mjs`. When imported by the MCP
// server this block does not run.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startWebDashboard().then((url) => {
    if (!url) {
      logErr("dashboard did not start");
      process.exit(1);
    }
    // Standalone: keep the process alive (the server is unref'd so we hold it
    // open ourselves) and print the URL to stdout for the human running it.
    process.stdout.write(`Cache Manager web dashboard: ${url}\n`);
    setInterval(() => {}, 1 << 30);
  });
}
