#!/usr/bin/env node
// Smoke test for the MCP overhead accounting (server/mcp-overhead.mjs).
import assert from "node:assert/strict";
import {
  schemaTokenEstimate,
  computeMcpOverhead,
  formatOverhead,
  estimateTokens,
} from "../server/mcp-overhead.mjs";

// A couple of representative tool defs (shape matches the real `tools` array).
const TOOLS = [
  {
    name: "heartbeat",
    description: "Record agent activity and return TTL/idle status.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Thread alias." },
        action: { type: "string", description: "What just happened." },
      },
    },
  },
  {
    name: "session_stats",
    description: "Aggregate token/cache usage and cost over a window.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", description: "session|alias|both" } },
    },
  },
];

// --- estimateTokens basics -------------------------------------------------
assert.equal(estimateTokens(""), 0, "empty string -> 0 tokens");
assert.equal(estimateTokens("12345678", 4), 2, "8 chars / 4 = 2 tokens");

// --- schema estimate -------------------------------------------------------
const schema = schemaTokenEstimate(TOOLS);
assert.equal(schema.tool_count, 2);
assert.ok(schema.estimated_tokens > 0, "schema must cost some tokens");
assert.ok(schema.json_chars > 0);
// Names should carry the wire prefix.
assert.ok(
  schema.per_tool.every((t) => t.name.startsWith("mcp__cache_manager__")),
  "tool names must be prefixed for the wire",
);
// per_tool sorted descending by tokens.
assert.ok(
  schema.per_tool[0].estimated_tokens >= schema.per_tool[1].estimated_tokens,
  "per_tool sorted by token cost",
);

// --- overhead report, cache-aware pricing ----------------------------------
const stats = {
  turns: 100,
  cold_start_turns: 1,
  models: ["claude-opus-4-8"],
  cache_read_tokens: 5_000_000,
  cache_creation_tokens: 170_000,
  ephemeral_5m_tokens: 0,
  ephemeral_1h_tokens: 170_000,
};
const callLog = {
  count: 3,
  byTool: {
    resume_or_start: { count: 1, argChars: 120, resultChars: 8000 },
    heartbeat: { count: 2, argChars: 80, resultChars: 1200 },
  },
};

const report = computeMcpOverhead({ tools: TOOLS, stats, callLog });
const tax = report.schema_tax;

assert.ok(tax.estimated_tokens_per_request > 0);
assert.equal(tax.turns, 100);
assert.equal(tax.cold_start_turns, 1);
assert.equal(tax.cached_turns, 99);
assert.ok(tax.cache_aware_usd > 0, "cache-aware cost must be positive");
// THE key honesty property: pricing the schema at full input rate massively
// overstates it because it lives in the cached prefix.
assert.ok(
  tax.naive_uncached_usd > tax.cache_aware_usd,
  "naive (full-input) pricing must exceed cache-aware",
);
assert.ok(
  tax.naive_overstatement_x > 5,
  `expected large overstatement, got ${tax.naive_overstatement_x}x`,
);
assert.ok(
  tax.pct_of_avg_turn_context !== null && tax.pct_of_avg_turn_context > 0,
  "should report schema share of per-turn context",
);

// --- per-call breakdown ----------------------------------------------------
assert.ok(report.per_call, "per_call present when callLog supplied");
assert.equal(report.per_call.total_calls, 3);
const resume = report.per_call.by_tool.find((t) => t.name === "resume_or_start");
assert.ok(resume.est_result_tokens > 0);
// Results sorted so the biggest (resume_or_start) is first.
assert.equal(report.per_call.by_tool[0].name, "resume_or_start");

// --- formatted summary -----------------------------------------------------
const text = formatOverhead(report);
assert.ok(text.includes("schema tax"), "summary mentions schema tax");
assert.ok(text.includes("counterfactual"), "summary keeps benefit qualitative");

// --- zero-turn edge case ---------------------------------------------------
const empty = computeMcpOverhead({
  tools: TOOLS,
  stats: { turns: 0, cold_start_turns: 0, models: [] },
});
assert.equal(empty.schema_tax.cache_aware_usd, 0);
assert.equal(empty.schema_tax.pct_of_avg_turn_context, null);

console.log("MCP overhead smoke test passed");
