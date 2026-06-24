#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server", "cache-manager.mjs");
const STORE_DIR = path.join(
  os.tmpdir(),
  `cache-manager-mcp-smoke-${process.pid}-${Date.now()}`,
);

// Hermetic transcript root so session_stats attribution is deterministic and
// never touches the real ~/.claude/projects logs. The server runs with cwd=ROOT,
// so transcripts must live under ROOT's slug. The fixture is written *after*
// start_session (see below) so its timestamps fall inside the session window
// and its mtime is newer than the window start — matching how a real chat's
// transcript is written during the session, not before it.
const TRANSCRIPT_DIR = path.join(
  os.tmpdir(),
  `cache-manager-mcp-smoke-tx-${process.pid}-${Date.now()}`,
);
const projectSlug = ROOT.replace(/[^a-zA-Z0-9]+/g, "-");
fs.mkdirSync(path.join(TRANSCRIPT_DIR, projectSlug), { recursive: true });

// One chat that recorded a `cache_manager` call bound to alias "smoke-test"
// plus a usage turn — so the session both binds (alias signal) and has spend to
// attribute.
function writeSmokeTranscript() {
  const ts = new Date().toISOString();
  fs.writeFileSync(
    path.join(TRANSCRIPT_DIR, projectSlug, "smokeChat.jsonl"),
    [
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        cwd: ROOT,
        sessionId: "smokeChat",
        message: {
          model: "claude-opus-4-8",
          content: [
            {
              type: "tool_use",
              name: "cache_manager.heartbeat",
              input: { alias: "smoke-test" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: ts,
        cwd: ROOT,
        sessionId: "smokeChat",
        message: {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 10,
            output_tokens: 50,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 100,
            cache_creation: { ephemeral_5m_input_tokens: 100 },
          },
        },
      }),
    ].join("\n") + "\n",
  );
}

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: {
    ...process.env,
    CACHE_MANAGER_STORE_DIR: STORE_DIR,
    CACHE_MANAGER_TRANSCRIPT_DIR: TRANSCRIPT_DIR,
    CACHE_MANAGER_WEB_DASHBOARD: "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function waitForResponses(count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const responses = stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (responses.length >= count) {
        clearInterval(timer);
        resolve(responses);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `Timed out waiting for ${count} MCP responses. stdout=${stdout} stderr=${stderr}`,
          ),
        );
      }
    }, 25);
  });
}

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-test", version: "0.0.0" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "start_session",
      arguments: { alias: "smoke-test", label: "MCP smoke test", ttl_seconds: 300 },
    },
  });

  // Wait for the session to exist, then write the chat transcript so its
  // timestamps land inside the session window (as a live chat's would).
  await waitForResponses(3);
  writeSmokeTranscript();

  // Attribution invariant: session_stats must resolve the same bound chat(s)
  // whether called by alias or by session_id only. Agents record cache_manager
  // calls with the alias (never the raw session_id), so the session_id-only
  // path must reverse-look-up the alias to match — otherwise it silently falls
  // back to the unfiltered time+cwd total and diverges from the dashboard.
  send({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "session_stats", arguments: { alias: "smoke-test" } },
  });
  send({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "session_stats", arguments: { session_id: "smoke-test" } },
  });

  const responses = await waitForResponses(5);
  const byId = new Map(responses.map((response) => [response.id, response]));

  assert.equal(byId.get(1)?.result?.serverInfo?.name, "cache-manager");
  assert.equal(byId.get(1)?.result?.capabilities?.tools instanceof Object, true);

  const toolNames = byId.get(2)?.result?.tools?.map((tool) => tool.name) ?? [];
  for (const name of [
    "start_session",
    "heartbeat",
    "status",
    "countdown",
    "handoff_prompt",
    "save_memory",
    "resume_or_start",
    "checkpoint",
    "latest_memory",
    "list_memories",
    "search_memories",
    "set_alias",
    "resolve_alias",
    "list_aliases",
    "session_stats",
  ]) {
    assert.ok(toolNames.includes(name), `missing tool: ${name}`);
  }

  const startPayload = JSON.parse(byId.get(3)?.result?.content?.[0]?.text ?? "{}");
  assert.equal(startPayload.ok, true);
  assert.equal(startPayload.status?.session_id, "smoke-test");

  const byAlias = JSON.parse(byId.get(4)?.result?.content?.[0]?.text ?? "{}");
  const bySession = JSON.parse(byId.get(5)?.result?.content?.[0]?.text ?? "{}");
  // Both must bind to the same exact chat and report it as exact attribution.
  assert.equal(byAlias.attribution?.exact, true, "alias path should bind exactly");
  assert.equal(
    bySession.attribution?.exact,
    true,
    "session_id-only path should bind exactly (reverse-lookup of alias)",
  );
  assert.deepEqual(
    [...(byAlias.attribution?.transcript_session_ids ?? [])].sort(),
    [...(bySession.attribution?.transcript_session_ids ?? [])].sort(),
    "alias and session_id paths must resolve identical bound transcripts",
  );
  assert.ok(
    byAlias.attribution.transcript_session_ids.includes("smokeChat"),
    "bound transcript should be the chat that recorded the cache_manager call",
  );
  // And the attributed usage reflects that one chat's single turn.
  assert.equal(byAlias.current_session?.turns, 1, "attributed to the bound turn");

  console.log("MCP smoke test passed");
} finally {
  child.kill();
}
