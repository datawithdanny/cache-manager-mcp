#!/usr/bin/env node
// Smoke test for the live turn timer: the running badge / elapsed must have NO
// idle/TTL ceiling (a long turn keeps counting instead of resetting ~5 min in),
// a generous max-turn safety valve self-heals a stuck/forgotten phase:"end",
// and the write side must reset a stale turn's start time on the next
// phase:"start" so it can't poison a fresh turn's elapsed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server", "cache-manager.mjs");
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-turn-smoke-"));
const SESSION_FILE = path.join(STORE_DIR, "sessions.json");
const ENV = { ...process.env, CACHE_MANAGER_STORE_DIR: STORE_DIR };

// ---------- Read side: sessionStatus has no idle/TTL ceiling ----------
const { sessionStatus, DEFAULT_MAX_TURN_MS } = await import(
  path.join(ROOT, "server", "session-status.mjs")
);
const now = Date.now();
const base = {
  id: "u",
  label: "u",
  ttl_ms: 300000,
  warn_before_ms: 45000,
  idle_ms: 240000,
  started_at_ms: now,
  ttl_anchor_ms: now,
  last_turn_ms: 12345,
};

// A turn running for 10 min — past both idle (4m) and TTL (5m) — stays running
// with a LIVE elapsed, not reset to the prior turn's last_turn_ms.
const long = sessionStatus({
  ...base,
  ttl_anchor_ms: now - 10 * 60 * 1000,
  last_action_at_ms: now - 10 * 60 * 1000,
  turn: { running: true, started_at_ms: now - 10 * 60 * 1000 },
});
assert.equal(long.running, true, "10-min turn must still be running (no ceiling)");
assert.equal(long.severity, "running", "severity stays running through idle/TTL");
assert.ok(
  Math.abs(long.turn_elapsed_ms - 10 * 60 * 1000) < 2000,
  `elapsed must be live ~600000, got ${long.turn_elapsed_ms}`,
);
assert.notEqual(long.turn_elapsed_ms, 12345, "elapsed must NOT fall back to last_turn_ms while running");

// A turn older than the max-turn safety valve self-heals to non-running and the
// display falls back to last_turn_ms.
const stuck = sessionStatus({
  ...base,
  last_action_at_ms: now,
  turn: { running: true, started_at_ms: now - DEFAULT_MAX_TURN_MS - 1000 },
});
assert.equal(stuck.running, false, "turn beyond max-turn valve must self-heal to non-running");
assert.equal(stuck.turn_elapsed_ms, 12345, "self-healed turn falls back to last_turn_ms");

// Custom per-session turn_max_ms is honored.
const customCap = sessionStatus({
  ...base,
  turn_max_ms: 5000,
  last_action_at_ms: now,
  turn: { running: true, started_at_ms: now - 6000 },
});
assert.equal(customCap.running, false, "custom turn_max_ms (5s) must cap a 6s turn");

// ---------- Write side: stale turn reset on phase:"start" ----------
const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => (stdout += c));
child.stderr.on("data", (c) => (stderr += c));

let nextId = 100;
const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const call = (name, args) => send({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } });
function waitFor(count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const r = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (r.length >= count) { clearInterval(t); resolve(r); }
      else if (Date.now() - started > timeoutMs) { clearInterval(t); reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)); }
    }, 25);
  });
}
const payload = (r) => JSON.parse(r.at(-1).result.content[0].text);
let expected = 0;
async function heartbeat(args) {
  call("heartbeat", args);
  expected += 1;
  return payload(await waitFor(expected));
}
const readStore = () => JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
const writeStore = (s) => fs.writeFileSync(SESSION_FILE, JSON.stringify(s));

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  expected += 1;

  call("start_session", { alias: "turn", label: "Turn", ttl_seconds: 300, idle_seconds: 240 });
  expected += 1;
  await waitFor(expected);

  // Open a turn.
  const opened = await heartbeat({ alias: "turn", phase: "start", action: "begin" });
  assert.equal(opened.status.running, true, "phase:start opens a running turn");
  const id = readStore() && Object.keys(readStore())[0];
  const origStart = readStore()[id].turn.started_at_ms;

  // (a) Re-start a still-LIVE turn (recent heartbeat) → idempotent, keeps start.
  const reLive = await heartbeat({ alias: "turn", phase: "start", action: "begin again" });
  assert.equal(reLive.status.running, true, "re-start keeps it running");
  assert.equal(readStore()[id].turn.started_at_ms, origStart, "live re-start keeps original started_at (idempotent)");

  // (b) Simulate a stale turn: backdate the turn start AND last heartbeat well
  // past the idle window, then phase:"start" again. Must open a FRESH turn, not
  // inherit the dead turn's start (which would show a wildly inflated elapsed).
  const s = readStore();
  const staleStart = Date.now() - 20 * 60 * 1000; // 20 min ago, > idle (4m)
  s[id].turn.started_at_ms = staleStart;
  s[id].turn.started_at = new Date(staleStart).toISOString();
  s[id].last_action_at_ms = staleStart;
  s[id].last_action_at = new Date(staleStart).toISOString();
  writeStore(s);

  const reStale = await heartbeat({ alias: "turn", phase: "start", action: "fresh turn" });
  assert.equal(reStale.status.running, true, "stale re-start is still running");
  assert.ok(
    reStale.status.turn_elapsed_ms < 5000,
    `stale turn must reset: elapsed should be ~0, got ${reStale.status.turn_elapsed_ms}`,
  );
  assert.notEqual(readStore()[id].turn.started_at_ms, staleStart, "stale turn start was reset");

  // (c) phase:"end" records last_turn_ms; subsequent status shows it (not live).
  const ended = await heartbeat({ alias: "turn", phase: "end", action: "done" });
  assert.equal(ended.status.running, false, "phase:end closes the turn");
  assert.ok(ended.status.last_turn_ms >= 0, "last_turn_ms recorded on end");

  console.log("turn-timer smoke test passed");
} finally {
  child.kill();
}
