#!/usr/bin/env node
// Verifies that a memory title containing an embedded extension (e.g. "AGENTS.md")
// does not leak into the saved filename and collide with the real `.md` we append.
// Regression test for names like `...claude.md.md`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server", "cache-manager.mjs");
const STORE_DIR = path.join(
  os.tmpdir(),
  `cache-manager-mcp-smoke-${process.pid}-${Date.now()}`,
);

const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, CACHE_MANAGER_STORE_DIR: STORE_DIR, CACHE_MANAGER_WEB_DASHBOARD: "0" },
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
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "save_memory",
      arguments: {
        alias: "filename-smoke",
        title: "Turn lifecycle invariants documented across AGENTS.md + CLAUDE.md",
        summary: "smoke",
      },
    },
  });

  const responses = await waitForResponses(2);
  const byId = new Map(responses.map((response) => [response.id, response]));

  const payload = JSON.parse(byId.get(2)?.result?.content?.[0]?.text ?? "{}");
  assert.equal(payload.ok, true, "save_memory should succeed");

  const base = path.basename(payload.path ?? "");
  assert.ok(base.length > 0, "save_memory should return a path");

  // Exactly one `.md` — the real extension — and no `.md.md` collision.
  assert.ok(base.endsWith(".md"), `filename should end in .md: ${base}`);
  assert.ok(!base.includes(".md.md"), `filename should not contain .md.md: ${base}`);

  // The title portion must contain no dots at all (they're collapsed to dashes);
  // only the timestamp-derived prefix uses dashes already, never dots.
  assert.ok(!base.slice(0, -3).includes("."), `filename body should have no dots: ${base}`);

  // Sanity: the title's words still survive in slug form.
  assert.ok(base.includes("agents-md"), `expected collapsed 'agents-md' in: ${base}`);
  assert.ok(base.includes("claude-md"), `expected collapsed 'claude-md' in: ${base}`);

  console.log(`memory filename smoke test passed (${base})`);
} finally {
  child.kill();
}
