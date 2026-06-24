#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dashboardPath = path.join(
  repoRoot,
  "server",
  "cache-manager-dashboard.mjs",
);

function runOnce(storeDir, extraEnv = {}, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [dashboardPath, "--once", ...extraArgs],
    {
      cwd: repoRoot,
      env: { ...process.env, CACHE_MANAGER_STORE_DIR: storeDir, ...extraEnv },
      encoding: "utf8",
    },
  );
  return result;
}

const checks = [];

// Case 1: empty store renders the friendly empty message, no crash, no ANSI.
{
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-empty-"),
  );
  const result = runOnce(storeDir);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  checks.push([result.status === 0, "empty store: exits successfully"]);
  checks.push([
    output.includes("No tracked sessions yet."),
    "empty store: shows empty message",
  ]);
  // Piped (non-TTY) output must stay plain — no screen-clear / color escapes.
  checks.push([
    !output.includes("\x1b["),
    "empty store: no ANSI escapes when piped",
  ]);
}

// Case 2: a populated store renders the table with the right countdown numbers.
{
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-full-"),
  );
  const now = Date.now();
  const sessions = {
    active: {
      id: "active",
      label: "Active session",
      ttl_ms: 300000,
      warn_before_ms: 45000,
      idle_ms: 240000,
      started_at_ms: now - 30000,
      ttl_anchor_ms: now - 30000, // 30s elapsed -> 4:30 TTL left
      last_action_at_ms: now - 30000, // idle 0:30
      started_at: new Date(now - 30000).toISOString(),
      last_action_at: new Date(now - 30000).toISOString(),
      actions: [],
    },
    expired: {
      id: "expired",
      label: "Expired session",
      ttl_ms: 300000,
      warn_before_ms: 45000,
      idle_ms: 240000,
      started_at_ms: now - 600000,
      ttl_anchor_ms: now - 600000, // 10m past anchor -> expired
      last_action_at_ms: now - 600000,
      started_at: new Date(now - 600000).toISOString(),
      last_action_at: new Date(now - 600000).toISOString(),
      actions: [],
    },
    // Has a cwd, so usage is computed. The hermetic (empty) transcript dir
    // below means it finds no turns -> renders "0/0" turns and "$0.00" cost,
    // exercising the usage path without depending on real transcripts.
    "with-cwd": {
      id: "with-cwd",
      label: "Has cwd",
      ttl_ms: 300000,
      warn_before_ms: 45000,
      idle_ms: 240000,
      started_at_ms: now - 30000,
      ttl_anchor_ms: now - 30000,
      last_action_at_ms: now - 30000,
      started_at: new Date(now - 30000).toISOString(),
      last_action_at: new Date(now - 30000).toISOString(),
      cwd: "/tmp/cache-manager-smoke-project",
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
    "cwd-thread": {
      alias: "cwd-thread",
      session_id: "with-cwd",
      title: "Has cwd",
      created_at: new Date(now - 30000).toISOString(),
      updated_at: new Date(now - 30000).toISOString(),
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

  // Hermetic transcript root: an empty dir so usage computes to zero rather
  // than reading the real ~/.claude/projects transcripts.
  const transcriptDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-transcripts-"),
  );
  const result = runOnce(storeDir, {
    CACHE_MANAGER_TRANSCRIPT_DIR: transcriptDir,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  checks.push([result.status === 0, "populated store: exits successfully"]);
  checks.push([
    output.includes("ALIAS / LABEL") && output.includes("TTL LEFT"),
    "populated store: renders table header",
  ]);
  checks.push([
    output.includes("TURNS") &&
      output.includes("TOKENS") &&
      output.includes("COST") &&
      output.includes("SAVINGS"),
    "populated store: renders usage column headers",
  ]);
  // Assert the alias-prefixed label renders (prefix is enough; the column may
  // ellipsise on narrower widths).
  checks.push([
    output.includes("my-thread (Active"),
    "populated store: shows alias-prefixed label",
  ]);
  // TTL math: ttl_anchor 30s ago, 300s TTL -> ~4:30 remaining (formatDuration
  // ceils, so 4:30).
  checks.push([
    output.includes("4:30"),
    "populated store: TTL countdown reflects ttl_anchor_ms",
  ]);
  checks.push([
    output.includes("expired"),
    "populated store: expired severity shown",
  ]);
  // The with-cwd session has a cwd but no transcripts -> 0 turns, $0.00 cost.
  checks.push([
    output.includes("0/0") && output.includes("$0.00"),
    "populated store: cwd session shows zeroed usage tally",
  ]);
  // The active session has no cwd -> its usage cells (turns/tokens/cost) all
  // render the em-dash placeholder. Assert on that row specifically (the bare
  // "—" also appears in empty TURN/LAST-ACTION cells, so a global check would
  // pass even if usage were wrong).
  const activeRow = output
    .split("\n")
    .find((line) => line.includes("my-thread (Active"));
  checks.push([
    Boolean(activeRow) && (activeRow.match(/—/g) || []).length >= 3,
    "populated store: cwd-less session shows — for usage cells",
  ]);
  checks.push([
    output.includes("3 session(s)"),
    "populated store: summary count correct",
  ]);
  // Rows sort by most recent LAST ACTION first. `active`/`with-cwd` acted 30s
  // ago; `expired` acted 10m ago -> it must render below both of them.
  const dataLines = output.split("\n");
  const idxActive = dataLines.findIndex((l) => l.includes("my-thread (Active"));
  const idxCwd = dataLines.findIndex((l) => l.includes("cwd-thread (Has cwd"));
  const idxExpired = dataLines.findIndex((l) =>
    l.includes("Expired session"),
  );
  checks.push([
    idxActive !== -1 &&
      idxCwd !== -1 &&
      idxExpired !== -1 &&
      idxExpired > idxActive &&
      idxExpired > idxCwd,
    "populated store: rows sorted by most recent LAST ACTION",
  ]);
}

// Case 3: --detail renders the full per-session token/cost breakdown, with
// real numbers from a written transcript line, and honors the alias filter.
{
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-detail-"),
  );
  const now = Date.now();
  const cwd = "/tmp/cache-manager-smoke-detail-project";
  const sessions = {
    detail: {
      id: "detail",
      label: "Detail session",
      ttl_ms: 300000,
      warn_before_ms: 45000,
      idle_ms: 240000,
      started_at_ms: now - 60000,
      ttl_anchor_ms: now - 60000,
      last_action_at_ms: now - 60000,
      started_at: new Date(now - 60000).toISOString(),
      last_action_at: new Date(now - 60000).toISOString(),
      cwd,
      actions: [],
    },
  };
  const aliases = {
    "detail-thread": {
      alias: "detail-thread",
      session_id: "detail",
      title: "Detail session",
      created_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 60000).toISOString(),
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

  // Hermetic transcript root containing one assistant usage line for this cwd,
  // so the breakdown shows real (non-zero) numbers. The cwd slug mirrors Claude
  // Code: every non-alphanumeric run becomes a single "-".
  const transcriptDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-detail-tx-"),
  );
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-");
  const projectDir = path.join(transcriptDir, slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const turn = {
    type: "assistant",
    timestamp: new Date(now - 30000).toISOString(),
    cwd,
    sessionId: "detail",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 300 },
        service_tier: "standard",
      },
    },
  };
  fs.writeFileSync(
    path.join(projectDir, "turn.jsonl"),
    `${JSON.stringify(turn)}\n`,
  );

  const env = { CACHE_MANAGER_TRANSCRIPT_DIR: transcriptDir };

  // Default (no --detail): table only, plus the hint to enable the panel.
  const plain = runOnce(storeDir, env);
  const plainOut = `${plain.stdout || ""}${plain.stderr || ""}`;
  checks.push([
    !plainOut.includes("USAGE DETAIL"),
    "detail: panel hidden by default",
  ]);
  checks.push([
    plainOut.includes("--detail"),
    "detail: default view hints at --detail",
  ]);

  // --detail: full breakdown panel with the checkpoint-summary fields.
  const detailed = runOnce(storeDir, env, ["--detail"]);
  const out = `${detailed.stdout || ""}${detailed.stderr || ""}`;
  checks.push([detailed.status === 0, "detail: exits successfully"]);
  checks.push([out.includes("USAGE DETAIL"), "detail: renders panel heading"]);
  checks.push([
    out.includes("▸ detail-thread"),
    "detail: renders per-session block header",
  ]);
  checks.push([
    out.includes("current session:") && out.includes("alias lifetime:"),
    "detail: renders both current + alias-lifetime blocks",
  ]);
  // The full checkpoint-summary fields, sourced from formatStats.
  checks.push([
    out.includes("cache: read=5000") &&
      out.includes("ttl_split: 5m=300") &&
      out.includes("cost: $"),
    "detail: renders cache / ttl_split / cost breakdown lines",
  ]);

  // --detail=<filter>: only matching aliases appear; non-matches don't.
  const filtered = runOnce(storeDir, env, ["--detail=nomatch"]);
  const fout = `${filtered.stdout || ""}${filtered.stderr || ""}`;
  checks.push([
    fout.includes("USAGE DETAIL") && !fout.includes("▸ detail-thread"),
    "detail: alias filter excludes non-matching sessions",
  ]);
}

// Case 4: per-chat attribution. Two chats share one project folder: one
// declared the alias via a recorded cache_manager tool call (so it binds, gets
// exact attribution, and the noise chat's spend is excluded); a second session
// never called cache_manager (so it can't bind and renders with the ~ marker).
{
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-attribution-"),
  );
  const now = Date.now();
  const cwd = "/tmp/cache-manager-smoke-attribution-project";
  const sessions = {
    bound: {
      id: "bound",
      label: "Bound session",
      ttl_ms: 300000,
      warn_before_ms: 45000,
      idle_ms: 240000,
      started_at_ms: now - 60000,
      ttl_anchor_ms: now - 60000,
      last_action_at_ms: now - 60000,
      started_at: new Date(now - 60000).toISOString(),
      last_action_at: new Date(now - 60000).toISOString(),
      cwd,
      actions: [],
    },
    unbound: {
      id: "unbound",
      label: "Unbound session",
      ttl_ms: 300000,
      warn_before_ms: 45000,
      idle_ms: 240000,
      started_at_ms: now - 90000,
      ttl_anchor_ms: now - 90000,
      last_action_at_ms: now - 90000,
      started_at: new Date(now - 90000).toISOString(),
      last_action_at: new Date(now - 90000).toISOString(),
      cwd,
      actions: [],
    },
  };
  const aliases = {
    "bound-thread": {
      alias: "bound-thread",
      session_id: "bound",
      title: "Bound session",
      created_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 60000).toISOString(),
    },
    "unbound-thread": {
      alias: "unbound-thread",
      session_id: "unbound",
      title: "Unbound session",
      created_at: new Date(now - 90000).toISOString(),
      updated_at: new Date(now - 90000).toISOString(),
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

  const transcriptDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "cache-manager-dashboard-attribution-tx-"),
  );
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-");
  const projectDir = path.join(transcriptDir, slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const ts = new Date(now - 30000).toISOString();
  const turn = (output) => ({
    input_tokens: 10,
    output_tokens: output,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 100,
    cache_creation: { ephemeral_5m_input_tokens: 100 },
  });
  // ownerChat: one recorded cache_manager call binding it to "bound-thread",
  // plus one usage turn (output=200).
  fs.writeFileSync(
    path.join(projectDir, "owner.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        cwd,
        sessionId: "ownerChat",
        message: {
          model: "claude-opus-4-8",
          content: [
            {
              type: "tool_use",
              name: "cache_manager.heartbeat",
              input: { alias: "bound-thread" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        cwd,
        sessionId: "ownerChat",
        message: { model: "claude-opus-4-8", usage: turn(200) },
      }),
    ].join("\n") + "\n",
  );
  // noiseChat: huge usage (output=9000), no cache_manager call. Must NOT be
  // attributed to the bound session.
  fs.writeFileSync(
    path.join(projectDir, "noise.jsonl"),
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      cwd,
      sessionId: "noiseChat",
      message: { model: "claude-opus-4-8", usage: turn(9000) },
    }) + "\n",
  );

  const result = runOnce(storeDir, {
    CACHE_MANAGER_TRANSCRIPT_DIR: transcriptDir,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const line = (needle) =>
    output.split("\n").find((l) => l.includes(needle)) || "";

  checks.push([result.status === 0, "attribution: exits successfully"]);
  // Bound row: exactly the owner chat's 1 turn (not the noise chat's), and its
  // cost cell carries no ~ marker (it was bound exactly).
  const boundLine = line("bound-thread (Bound");
  checks.push([
    boundLine.includes("1/1") && !boundLine.includes("~"),
    `attribution: bound row counts only its chat, no ~ marker (line: ${boundLine.trim()})`,
  ]);
  // The noise chat's 9000-output turn would dominate cost if leaked in; assert
  // the bound row is NOT the all-chats total (which would read 2/2).
  checks.push([
    !boundLine.includes("2/2"),
    "attribution: noise chat excluded from bound row",
  ]);
  // Unbound row: no recorded cache_manager call -> falls back to the full
  // time+cwd total (both chats = 2 turns) and is flagged with ~.
  const unboundLine = line("unbound-thread (Unbound");
  checks.push([
    unboundLine.includes("2/2") && unboundLine.includes("~"),
    `attribution: unbound row falls back + marked ~ (line: ${unboundLine.trim()})`,
  ]);
  checks.push([
    output.includes("couldn't be bound to a specific chat"),
    "attribution: footnote explains the ~ fallback rows",
  ]);
}

const failed = checks.filter(([ok]) => !ok);
if (failed.length > 0) {
  for (const [, message] of failed) {
    console.error(`FAILED: ${message}`);
  }
  process.exit(1);
}

console.log("smoke dashboard test passed");
