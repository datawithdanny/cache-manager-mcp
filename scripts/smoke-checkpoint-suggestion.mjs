#!/usr/bin/env node
// Smoke test for the proactive checkpoint-suggestion feature: the work-volume
// hint, the bundled handoff prompt + stats, counter resets on every save path,
// threshold carry-through across a checkpoint-restart, and the sessionStatus
// suppression rules (running / should_summarize).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server", "cache-manager.mjs");
const STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-cp-smoke-"));
const ENV = { ...process.env, CACHE_MANAGER_STORE_DIR: STORE_DIR };

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

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  expected += 1;

  // --- Case A: action-threshold trigger + bundle, then checkpoint(restart) re-arm ---
  call("start_session", { alias: "cp-a", label: "CP A", ttl_seconds: 300, checkpoint_after_actions: 3, checkpoint_after_minutes: 999 });
  expected += 1;
  await waitFor(expected);

  for (let i = 1; i <= 2; i++) {
    const p = await heartbeat({ alias: "cp-a", action: `step ${i}` });
    assert.equal(p.status.checkpoint_suggested, false, `hb ${i} should not suggest`);
    assert.equal(p.checkpoint_suggestion, undefined, `hb ${i} should carry no bundle`);
  }
  const fired = await heartbeat({ alias: "cp-a", phase: "end", action: "step 3" });
  assert.equal(fired.status.checkpoint_suggested, true, "hb 3 should suggest");
  assert.ok(fired.checkpoint_suggestion, "bundle present");
  for (const k of ["reason", "handoff_prompt", "stats", "stats_text", "next_step"]) {
    assert.ok(k in fired.checkpoint_suggestion, `bundle missing key: ${k}`);
  }
  assert.ok(/Summarize/i.test(fired.checkpoint_suggestion.handoff_prompt), "bundle includes example handoff prompt");
  assert.ok(/checkpoint/i.test(fired.status.recommendation), "recommendation mentions checkpoint");

  // checkpoint (restart) → fresh session, counter 0, thresholds carried forward.
  call("checkpoint", { alias: "cp-a", title: "CP A handoff", summary: "compact restart summary", tags: ["test"] });
  expected += 1;
  const cp = payload(await waitFor(expected));
  assert.equal(cp.status?.actions_since_checkpoint, 0, "checkpoint restart resets counter");
  assert.equal(cp.status?.checkpoint_suggested, false, "post-checkpoint should not re-suggest");
  // Threshold carry-through (#3): custom 3-action cadence must survive the restart.
  await heartbeat({ alias: "cp-a", action: "post 1" });
  await heartbeat({ alias: "cp-a", action: "post 2" });
  const reFired = await heartbeat({ alias: "cp-a", action: "post 3" });
  assert.equal(reFired.status.checkpoint_suggested, true, "custom threshold (3) should survive checkpoint-restart");

  // --- Case B: save_memory resets the counter (id-resolution parity) ---
  call("start_session", { alias: "cp-b", label: "CP B", ttl_seconds: 300, checkpoint_after_actions: 2, checkpoint_after_minutes: 999 });
  expected += 1;
  await waitFor(expected);
  await heartbeat({ alias: "cp-b", action: "b1" });
  const bFired = await heartbeat({ alias: "cp-b", action: "b2" });
  assert.equal(bFired.status.checkpoint_suggested, true, "cp-b should suggest at 2 actions");

  call("save_memory", { alias: "cp-b", title: "B handoff", summary: "b summary", tags: ["test"] });
  expected += 1;
  await waitFor(expected);
  const bAfter = await heartbeat({ alias: "cp-b", action: "b3" });
  assert.equal(bAfter.status.actions_since_checkpoint, 1, "save_memory must reset the counter (got " + bAfter.status.actions_since_checkpoint + ")");
  assert.equal(bAfter.status.checkpoint_suggested, false, "save_memory should re-arm the hint");

  // --- Case C: checkpoint(restart_session:false) resets the existing session ---
  call("start_session", { alias: "cp-c", label: "CP C", ttl_seconds: 300, checkpoint_after_actions: 2, checkpoint_after_minutes: 999 });
  expected += 1;
  await waitFor(expected);
  await heartbeat({ alias: "cp-c", action: "c1" });
  await heartbeat({ alias: "cp-c", action: "c2" });
  call("checkpoint", { alias: "cp-c", title: "C handoff", summary: "c summary", restart_session: false, tags: ["test"] });
  expected += 1;
  const cpC = payload(await waitFor(expected));
  assert.equal(cpC.action, "saved_memory", "restart_session:false should not start a session");
  const cAfter = await heartbeat({ alias: "cp-c", action: "c3" });
  assert.equal(cAfter.status.actions_since_checkpoint, 1, "checkpoint(no-restart) must reset the existing counter (got " + cAfter.status.actions_since_checkpoint + ")");
  assert.equal(cAfter.status.checkpoint_suggested, false, "checkpoint(no-restart) should re-arm the hint");

  // --- sessionStatus unit checks: time trigger + suppression rules ---
  const { sessionStatus } = await import(path.join(ROOT, "server", "session-status.mjs"));
  const now = Date.now();
  const base = { id: "u", label: "u", ttl_ms: 300000, warn_before_ms: 45000, idle_ms: 240000, started_at_ms: now, ttl_anchor_ms: now, last_action_at_ms: now, checkpoint_after_actions: 20, checkpoint_after_ms: 30 * 60 * 1000 };
  assert.equal(sessionStatus({ ...base, last_checkpoint_at_ms: now - 31 * 60 * 1000, actions_since_checkpoint: 1 }).checkpoint_suggested, true, "31min should suggest");
  assert.equal(sessionStatus({ ...base, last_checkpoint_at_ms: now - 31 * 60 * 1000, actions_since_checkpoint: 99, turn: { running: true, started_at_ms: now } }).checkpoint_suggested, false, "suppressed while running");
  assert.equal(sessionStatus({ ...base, ttl_anchor_ms: now - 299000, last_checkpoint_at_ms: now - 31 * 60 * 1000, actions_since_checkpoint: 99 }).checkpoint_suggested, false, "suppressed under TTL pressure");

  console.log("checkpoint-suggestion smoke test passed");
} finally {
  child.kill();
}
