// ---------------------------------------------------------------------------
// MCP overhead accounting
// ---------------------------------------------------------------------------
// Quantifies the *extra* tokens cache-manager adds to a model's context so a
// user can weigh the cost against the benefit of running the server.
//
// There are two distinct costs, and they behave very differently:
//
//   1. SCHEMA TAX (recurring, dominant). The tool definitions are serialized by
//      the MCP client and injected into the request context on EVERY turn while
//      the server is connected. Crucially they live in the stable cached prefix,
//      so after the first cold turn they bill at the ~0.1x cache-READ rate, not
//      full input. Pricing them at full input rate overstates the cost ~10x and
//      makes this whole feature misleading — so we price cold-start turns at the
//      cache-creation rate and the rest at the cache-read rate, reusing the
//      cold-start/cached split aggregateUsage() already computes.
//
//   2. PER-CALL COST (variable). Each invocation emits a tool_use block (the
//      args, output tokens) and returns a tool_result that re-enters context as
//      input on the next turn. Result size dominates — resume_or_start and
//      checkpoint return whole memories inline. We measure this from the actual
//      JSON the server emitted this process lifetime; it is not priced because
//      attributing it to cache-read vs input across turns isn't knowable here.
//
// We deliberately do NOT estimate a "savings" number. The benefit of
// cache-manager (avoided re-derivation after a restart) is counterfactual and
// not recoverable from transcripts. Reporting a fabricated benefit would be the
// easy way to look good and be wrong.

import { loadPricing, rateForModel } from "./transcript-stats.mjs";

// The wire-name prefix the MCP client prepends to every tool. It is derived
// from the client-side config KEY (e.g. `cache_manager`), not this package, so
// it is overridable; the default matches the intended `cache_manager` key.
export const DEFAULT_TOOL_PREFIX =
  process.env.CACHE_MANAGER_TOOL_PREFIX || "mcp__cache_manager__";

// Rough bytes-per-token for English+JSON. A real tokenizer would be more exact
// but pulls a dependency into a deliberately dep-free server; chars/4 is the
// widely used approximation. Override via env if you have a measured ratio.
export const DEFAULT_CHARS_PER_TOKEN = Number(
  process.env.CACHE_MANAGER_CHARS_PER_TOKEN || 4,
);

export function estimateTokens(str, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  if (!str) return 0;
  const len = typeof str === "string" ? str.length : String(str).length;
  return Math.ceil(len / charsPerToken);
}

// Serialize the tools array the way an MCP client forwards it to the model:
// one entry per tool with the prefixed name, description, and input schema.
export function serializeToolsForWire(tools, prefix = DEFAULT_TOOL_PREFIX) {
  return (tools || []).map((t) => ({
    name: `${prefix}${t.name}`,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// Per-tool and total schema-token estimate.
export function schemaTokenEstimate(
  tools,
  { prefix = DEFAULT_TOOL_PREFIX, charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {},
) {
  const wire = serializeToolsForWire(tools, prefix);
  const perTool = wire.map((entry) => {
    const chars = JSON.stringify(entry).length;
    return {
      name: entry.name,
      json_chars: chars,
      estimated_tokens: estimateTokens(JSON.stringify(entry), charsPerToken),
    };
  });
  const json = JSON.stringify(wire);
  return {
    tool_count: wire.length,
    json_chars: json.length,
    estimated_tokens: estimateTokens(json, charsPerToken),
    chars_per_token: charsPerToken,
    estimate_note:
      "token counts are chars/" +
      charsPerToken +
      " estimates (dep-free; no tokenizer)",
    per_tool: perTool.sort((a, b) => b.estimated_tokens - a.estimated_tokens),
  };
}

function round4(n) {
  return Number(n.toFixed(4));
}

// Compute the full overhead report for one stats window.
//   tools:    the server's tool definition array (source of truth)
//   stats:    an aggregateUsage() result (turns, cold_start_turns, models, ...)
//   callLog:  optional { count, byTool: { name: {count, argChars, resultChars} } }
//             measured by the live server process this lifetime.
export function computeMcpOverhead({
  tools,
  stats,
  callLog = null,
  prefix = DEFAULT_TOOL_PREFIX,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
} = {}) {
  const schema = schemaTokenEstimate(tools, { prefix, charsPerToken });
  const turns = stats?.turns || 0;
  const coldStarts = stats?.cold_start_turns || 0;
  const cachedTurns = Math.max(0, turns - coldStarts);

  const pricing = loadPricing();
  const model = stats?.models?.[0] || null;
  const rate = rateForModel(pricing, model);

  // Cold turns write the schema into cache (creation rate); pick the TTL tier
  // that dominated this window. Cached turns re-read it at the read rate.
  const creationRate =
    (stats?.ephemeral_1h_tokens || 0) > (stats?.ephemeral_5m_tokens || 0)
      ? rate.cacheWrite1h
      : rate.cacheWrite5m;

  const tok = schema.estimated_tokens;
  const cacheAwareUsd =
    (tok * (coldStarts * creationRate + cachedTurns * rate.cacheRead)) /
    1_000_000;
  // What you'd wrongly conclude if you ignored caching — shown only to make the
  // ~10x gap visible, never used as the headline number.
  const naiveUncachedUsd = (tok * turns * rate.input) / 1_000_000;

  // Share of the average per-turn cached context the schema occupies.
  const cachedContext =
    (stats?.cache_read_tokens || 0) + (stats?.cache_creation_tokens || 0);
  const avgContextPerTurn = turns > 0 ? cachedContext / turns : 0;
  const pctOfContext =
    avgContextPerTurn > 0
      ? round4((tok / avgContextPerTurn) * 100)
      : null;

  const report = {
    estimate_note: schema.estimate_note,
    pricing_model: model || "(unknown, fallback rate)",
    schema_tax: {
      tool_count: schema.tool_count,
      estimated_tokens_per_request: tok,
      json_chars: schema.json_chars,
      turns,
      cold_start_turns: coldStarts,
      cached_turns: cachedTurns,
      cache_aware_usd: round4(cacheAwareUsd),
      naive_uncached_usd: round4(naiveUncachedUsd),
      naive_overstatement_x:
        cacheAwareUsd > 0
          ? round4(naiveUncachedUsd / cacheAwareUsd)
          : null,
      pct_of_avg_turn_context: pctOfContext,
      note:
        "schema is injected every request; priced at cache-creation on cold-start turns and cache-read on cached turns (NOT full input)",
    },
    largest_tools: schema.per_tool.slice(0, 5),
  };

  if (callLog && callLog.count > 0) {
    // Per-tool breakdown from raw char tallies measured by the live server.
    const calls = Object.entries(callLog.byTool || {})
      .map(([name, c]) => ({
        name,
        count: c.count,
        est_arg_tokens: Math.ceil(c.argChars / charsPerToken),
        est_result_tokens: Math.ceil(c.resultChars / charsPerToken),
      }))
      .sort((a, b) => b.est_result_tokens - a.est_result_tokens);
    const totalResultTokens = calls.reduce(
      (s, c) => s + c.est_result_tokens,
      0,
    );
    const totalArgTokens = calls.reduce((s, c) => s + c.est_arg_tokens, 0);
    report.per_call = {
      scope: "this server process only (resets on restart)",
      total_calls: callLog.count,
      est_result_tokens: totalResultTokens,
      est_arg_tokens: totalArgTokens,
      note: "tool RESULTS re-enter context as input next turn; results dominate. Not priced — cache-read vs input attribution isn't knowable here.",
      by_tool: calls,
    };
  }

  return report;
}

// Compact human-readable block for the session_stats text output.
export function formatOverhead(report) {
  if (!report) return "";
  const s = report.schema_tax;
  const lines = [
    "MCP OVERHEAD (cache-manager's own token cost):",
    `  schema tax: ${s.tool_count} tools ≈ ${s.estimated_tokens_per_request} tokens added to EVERY request`,
    `  this window: ${s.turns} turns (${s.cold_start_turns} cold, ${s.cached_turns} cached) ≈ $${s.cache_aware_usd} USD (cache-aware)`,
  ];
  if (s.naive_overstatement_x) {
    lines.push(
      `    (priced naively at full input rate it'd read $${s.naive_uncached_usd}, ${s.naive_overstatement_x}x higher — caching is why it's cheap)`,
    );
  }
  if (s.pct_of_avg_turn_context !== null) {
    lines.push(
      `    schema ≈ ${s.pct_of_avg_turn_context}% of your average per-turn context`,
    );
  }
  if (report.per_call) {
    const p = report.per_call;
    lines.push(
      `  per-call (this process, ${p.total_calls} calls): ≈${p.est_result_tokens} result + ${p.est_arg_tokens} arg tokens`,
    );
  }
  lines.push(
    "  benefit (restored memory → avoided re-derivation) is counterfactual and intentionally not given a dollar figure.",
  );
  lines.push(`  ${report.estimate_note}`);
  return lines.join("\n");
}
