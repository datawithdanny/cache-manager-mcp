#!/usr/bin/env node
// Smoke test for web-dashboard FAILOVER. Every MCP client spawns its own server
// process but only the first to bind the port serves HTTP; the rest reuse the
// URL. If the owner exits, a non-owning instance must take over the freed port
// so the dashboard survives as long as ANY tracked chat is alive. This test:
//   1. binds the port with a stand-in "owner" server,
//   2. starts a dashboard instance -> it reuses the URL (owner still serves),
//   3. closes the owner,
//   4. asserts the dashboard instance takes over and now serves the port.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-manager-failover-store-"));
const transcriptDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "cache-manager-failover-transcripts-"),
);
const PORT = 41988; // clear of the default (41734) and the other smoke (41987)
const HOST = "127.0.0.1";
const URL = `http://${HOST}:${PORT}`;

process.env.CACHE_MANAGER_STORE_DIR = storeDir;
process.env.CACHE_MANAGER_TRANSCRIPT_DIR = transcriptDir;
process.env.CACHE_MANAGER_DASHBOARD_PORT = String(PORT);
// Fast failover so the test doesn't wait the 3s production default.
const RETRY_MS = 150;
process.env.CACHE_MANAGER_DASHBOARD_RETRY_MS = String(RETRY_MS);

// Minimal store so /api/sessions has something to read once we take over.
fs.writeFileSync(path.join(storeDir, "sessions.json"), "{}\n");
fs.writeFileSync(path.join(storeDir, "aliases.json"), "{}\n");

const { startWebDashboard } = await import("../server/cache-manager-web.mjs");

const checks = [];
function check(cond, label) {
  checks.push([Boolean(cond), label]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in "owner" already holding the port. It answers /api/health with a
// distinctive marker so we can tell who is currently serving.
const owner = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, who: "owner" }));
});
await new Promise((resolve) => owner.listen(PORT, HOST, resolve));

// The dashboard instance must reuse the URL (not error) while the owner holds it.
const url = await startWebDashboard();
check(url === URL, "non-owning instance resolves to the shared URL (reuse)");

// Before takeover the OWNER is still the one serving.
{
  const res = await fetch(`${URL}/api/health`, { cache: "no-store" });
  const body = await res.json();
  check(body.who === "owner", "owner still serves the port before it exits");
}

// Owner exits -> port frees. The dashboard's background retry loop should bind.
await new Promise((resolve) => owner.close(resolve));
// Wait several retry intervals for the takeover to land.
let tookOver = false;
for (let i = 0; i < 40; i++) {
  await sleep(RETRY_MS);
  try {
    const res = await fetch(`${URL}/api/health`, { cache: "no-store" });
    const body = await res.json();
    if (body.who !== "owner" && body.ok === true && body.store_dir === storeDir) {
      tookOver = true;
      break;
    }
  } catch {
    /* port momentarily unbound between owner.close and the retry bind */
  }
}
check(tookOver, "dashboard takes over the freed port (failover)");

// And the taken-over server serves real dashboard routes.
if (tookOver) {
  const res = await fetch(`${URL}/api/sessions`, { cache: "no-store" });
  const body = await res.json();
  check(res.status === 200 && Array.isArray(body.rows), "taken-over dashboard serves /api/sessions");
}

let failed = 0;
for (const [ok, label] of checks) {
  process.stdout.write(`${ok ? "✅" : "❌"} ${label}\n`);
  if (!ok) failed++;
}
process.stdout.write(
  failed === 0
    ? `\ndashboard-failover smoke: all ${checks.length} checks passed\n`
    : `\ndashboard-failover smoke: ${failed}/${checks.length} checks FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
