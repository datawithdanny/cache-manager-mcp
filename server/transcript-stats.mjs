// Transcript usage stats for cache-manager.
//
// Reads agent transcript logs and aggregates token/cache usage over a time
// window, so cache-manager can report cache hit/miss behaviour for a tracking
// session (and for an alias's whole lifetime) at checkpoint/summarize time.
//
// There is no shared identifier between a cache-manager tracking session and an
// agent transcript, so the bridge is purely by TIME WINDOW: we aggregate the
// usage lines whose timestamp falls inside [windowStartMs, windowEndMs].
//
// Sources are pluggable. Today only Claude Code transcripts are supported; the
// `SOURCES` registry is the seam where another agent parser drops in later —
// each source just needs `discover()` + `parseLine()`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Source: Claude Code
// ---------------------------------------------------------------------------
// Transcripts live at ~/.claude/projects/<cwd-slug>/<uuid>.jsonl. Each assistant
// line is a JSON object with a top-level `timestamp`, `cwd`, `sessionId` and a
// `message.usage` block.

function claudeTranscriptRoot() {
  return (
    process.env.CACHE_MANAGER_TRANSCRIPT_DIR ??
    path.join(os.homedir(), ".claude", "projects")
  );
}

// Claude Code slugs a cwd by replacing every non-alphanumeric run with "-".
function claudeCwdSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]+/g, "-");
}

function listJsonlFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

const claudeSource = {
  name: "claude-code",

  // Return candidate transcript files. We pre-filter by file mtime so we never
  // open a transcript that was last written before the window opened. When a
  // cwd is provided we look only at that project's slug dir; otherwise we scan
  // every project under the root.
  discover({ cwd, windowStartMs } = {}) {
    const root = claudeTranscriptRoot();
    let dirs = [];
    if (cwd) {
      dirs = [path.join(root, claudeCwdSlug(cwd))];
    } else {
      let projectDirs;
      try {
        projectDirs = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      dirs = projectDirs
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
    }

    const files = [];
    for (const dir of dirs) {
      for (const file of listJsonlFiles(dir)) {
        // mtime pre-filter: skip files untouched since before the window.
        try {
          if (windowStartMs && fs.statSync(file).mtimeMs < windowStartMs) {
            continue;
          }
        } catch {
          continue;
        }
        files.push(file);
      }
    }
    return files;
  },

  // Parse one JSONL line into a normalized usage record, or null if the line is
  // not an assistant turn with usage (fail-soft on any malformed line).
  parseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (obj?.type !== "assistant") return null;
    const usage = obj?.message?.usage;
    if (!usage) return null;
    const ts = Date.parse(obj.timestamp);
    if (Number.isNaN(ts)) return null;

    const cacheCreation = usage.cache_creation || {};
    return {
      source: "claude-code",
      ts,
      cwd: obj.cwd ?? null,
      transcriptSessionId: obj.sessionId ?? null,
      model: obj.message?.model ?? null,
      serviceTier: usage.service_tier ?? null,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheCreationTokens: num(usage.cache_creation_input_tokens),
      ephemeral5mTokens: num(cacheCreation.ephemeral_5m_input_tokens),
      ephemeral1hTokens: num(cacheCreation.ephemeral_1h_input_tokens),
    };
  },

  // Emit one normalized usage record per assistant turn whose timestamp falls
  // inside [windowStartMs, windowEndMs]. Claude reports per-line, so each turn
  // is its own record; the cache "miss baseline" is cache-creation tokens
  // (tokens that had to be written rather than read).
  collect({ cwd, windowStartMs, windowEndMs } = {}) {
    const start = num(windowStartMs);
    const end = windowEndMs ? num(windowEndMs) : Infinity;
    const records = [];
    let filesScanned = 0;
    let linesSkipped = 0;

    for (const file of this.discover({ cwd, windowStartMs })) {
      let content;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      filesScanned += 1;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const rec = this.parseLine(line);
        if (!rec) {
          linesSkipped += 1;
          continue;
        }
        if (rec.ts < start || rec.ts > end) continue;
        records.push({
          source: "claude-code",
          // The transcript (chat) this turn belongs to. Carried through so
          // aggregateUsage can filter to a specific set of chats — see the
          // `sessionIds` filter and resolveTranscriptSessionIds below.
          transcriptSessionId: rec.transcriptSessionId,
          model: rec.model,
          serviceTier: rec.serviceTier,
          turns: 1,
          coldStarts: rec.cacheReadTokens === 0 ? 1 : 0,
          input: rec.inputTokens,
          output: rec.outputTokens,
          cacheRead: rec.cacheReadTokens,
          cacheCreation: rec.cacheCreationTokens,
          e5m: rec.ephemeral5mTokens,
          e1h: rec.ephemeral1hTokens,
          missBaseline: rec.cacheCreationTokens,
        });
      }
    }
    return { records, meta: { filesScanned, linesSkipped } };
  },

  // Scan transcripts for the cache-manager tool calls they recorded, so a chat
  // can be bound to the tracking session(s) it heartbeated against. Every
  // `resume_or_start` / `heartbeat` / `start_session` call the agent makes is
  // written into that chat's own transcript as a `tool_use` block with its
  // `alias` / `session_id` in the input — a deterministic owner declaration,
  // far stronger than time-window correlation. Returns one entry per transcript
  // that referenced at least one alias or session id.
  scanBindings({ cwd, windowStartMs } = {}) {
    const bindings = [];
    for (const file of this.discover({ cwd, windowStartMs })) {
      let content;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let transcriptSessionId = null;
      const aliases = new Set();
      const sessionIds = new Set();
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj?.sessionId && !transcriptSessionId) {
          transcriptSessionId = obj.sessionId;
        }
        const blocks = obj?.message?.content;
        if (!Array.isArray(blocks)) continue;
        for (const b of blocks) {
          if (b?.type !== "tool_use") continue;
          if (!/cache.manager/i.test(b.name || "")) continue;
          const input = b.input || {};
          if (input.alias) aliases.add(String(input.alias));
          if (input.session_id) sessionIds.add(String(input.session_id));
        }
      }
      if (transcriptSessionId && (aliases.size || sessionIds.size)) {
        bindings.push({ transcriptSessionId, aliases, sessionIds });
      }
    }
    return bindings;
  },
};

const SOURCES = [claudeSource];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
// USD per 1,000,000 tokens. These are published list prices as of 2026-06 and
// can drift — override the whole table (or any subset) by setting
// CACHE_MANAGER_PRICING to a JSON object keyed by model id. cacheWrite5m/1h are
// the ephemeral cache-creation rates (5-minute and 1-hour TTL); cacheRead is the
// discounted cache-read rate.
const DEFAULT_PRICING = {
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
  },
};

// Unknown models fall back to these rates (current Opus list price) so cost is
// never silently zero. Prefix matching handles dated-snapshot ids like
// "claude-opus-4-8-20260...".
const FALLBACK_RATE = DEFAULT_PRICING["claude-opus-4-8"];

// Fraction of cache-read tokens to re-price at the full (uncached) input rate
// in the "what if the cache had mostly missed" hypothetical. Isolates the
// dominant 0.1x -> 1.0x swing while holding everything else constant.
const HYPOTHETICAL_MISS_RATE = 0.9;

export function loadPricing() {
  const raw = process.env.CACHE_MANAGER_PRICING;
  if (!raw) return DEFAULT_PRICING;
  try {
    const override = JSON.parse(raw);
    return { ...DEFAULT_PRICING, ...override };
  } catch {
    return DEFAULT_PRICING;
  }
}

export function rateForModel(pricing, model) {
  if (!model) return FALLBACK_RATE;
  if (pricing[model]) return pricing[model];
  // Prefix match against known ids (handles dated snapshots / fast variants).
  for (const id of Object.keys(pricing)) {
    if (model.startsWith(id)) return pricing[id];
  }
  return FALLBACK_RATE;
}

function round4(n) {
  return Number(n.toFixed(4));
}

// Cost (USD) for one model's token tallies.
function costForTokens(rate, t) {
  return (
    (t.input * rate.input +
      t.output * rate.output +
      t.cacheRead * rate.cacheRead +
      t.e5m * rate.cacheWrite5m +
      t.e1h * rate.cacheWrite1h) /
    1_000_000
  );
}

// Compute actual + hypothetical-high-miss cost from a per-model token map.
// byModel: { "<model>": {input, output, cacheRead, e5m, e1h} }.
export function computeCost(byModel) {
  const pricing = loadPricing();
  let actual = 0;
  let hypothetical = 0;
  const component = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const perModel = {};

  for (const [model, t] of Object.entries(byModel)) {
    const rate = rateForModel(pricing, model);
    const cost = costForTokens(rate, t);
    // Re-price HYPOTHETICAL_MISS_RATE of cache reads as full-price input.
    const missTokens = t.cacheRead * HYPOTHETICAL_MISS_RATE;
    const hypoCost =
      cost + (missTokens * (rate.input - rate.cacheRead)) / 1_000_000;
    actual += cost;
    hypothetical += hypoCost;
    component.input += (t.input * rate.input) / 1_000_000;
    component.output += (t.output * rate.output) / 1_000_000;
    component.cache_read += (t.cacheRead * rate.cacheRead) / 1_000_000;
    component.cache_creation +=
      (t.e5m * rate.cacheWrite5m + t.e1h * rate.cacheWrite1h) / 1_000_000;
    perModel[model || "(unknown)"] = round4(cost);
  }

  return {
    currency: "USD",
    estimated_usd: round4(actual),
    by_component: {
      input: round4(component.input),
      output: round4(component.output),
      cache_read: round4(component.cache_read),
      cache_creation: round4(component.cache_creation),
    },
    by_model: perModel,
    hypothetical_high_miss: {
      miss_rate: HYPOTHETICAL_MISS_RATE,
      estimated_usd: round4(hypothetical),
      extra_usd: round4(hypothetical - actual),
      multiplier_vs_actual: actual > 0 ? round4(hypothetical / actual) : null,
    },
    pricing_note:
      "USD list prices as of 2026-06; override via CACHE_MANAGER_PRICING",
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function emptyStats(windowStartMs, windowEndMs) {
  return {
    window: {
      start: isoOrNull(windowStartMs),
      end: isoOrNull(windowEndMs),
      duration_ms:
        windowStartMs && windowEndMs
          ? Math.max(0, windowEndMs - windowStartMs)
          : null,
    },
    turns: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cache_hit_ratio: null,
    cold_start_turns: 0,
    ephemeral_5m_tokens: 0,
    ephemeral_1h_tokens: 0,
    models: [],
    service_tiers: [],
    sources: [],
    transcript_files_scanned: 0,
    lines_skipped: 0,
  };
}

function isoOrNull(ms) {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : null;
}

// Aggregate usage records that fall inside [windowStartMs, windowEndMs].
// `cwd` (optional) restricts Claude Code discovery to one project's transcripts.
// `sessionIds` (optional Set<string>) restricts to records from those specific
// transcript (chat) ids — used to attribute usage to the exact chat(s) a
// tracking session owns. When absent the behaviour is unchanged (time+cwd
// only); when present, records from other chats (and records with no
// identifiable transcript id) are skipped.
export function aggregateUsage({
  windowStartMs,
  windowEndMs,
  cwd,
  sessionIds,
} = {}) {
  const idFilter =
    sessionIds instanceof Set && sessionIds.size > 0 ? sessionIds : null;
  const stats = emptyStats(windowStartMs, windowEndMs);
  const models = new Set();
  const tiers = new Set();
  const sourcesSeen = new Set();
  // Per-model token tallies so cost can be priced with each model's own rates
  // and summed (correct when a window spans more than one model).
  const byModel = {};
  // Tokens that were NOT served from cache, used as the hit-ratio denominator.
  // For Claude this is cache-creation (the write tier); each record declares
  // its own miss baseline.
  let missBaselineTotal = 0;

  for (const source of SOURCES) {
    let collected;
    try {
      collected = source.collect({ cwd, windowStartMs, windowEndMs });
    } catch {
      continue;
    }
    if (!collected) continue;
    stats.transcript_files_scanned += collected.meta?.filesScanned || 0;
    stats.lines_skipped += collected.meta?.linesSkipped || 0;

    for (const rec of collected.records) {
      // When an id filter is active, only count turns from the bound chat(s).
      // Records with no transcript id can't be attributed, so they drop out.
      if (idFilter && !idFilter.has(rec.transcriptSessionId)) continue;
      stats.turns += rec.turns;
      stats.input_tokens += rec.input;
      stats.output_tokens += rec.output;
      stats.cache_read_tokens += rec.cacheRead;
      stats.cache_creation_tokens += rec.cacheCreation;
      stats.ephemeral_5m_tokens += rec.e5m;
      stats.ephemeral_1h_tokens += rec.e1h;
      stats.cold_start_turns += rec.coldStarts;
      missBaselineTotal += rec.missBaseline;
      if (rec.model) models.add(rec.model);
      if (rec.serviceTier) tiers.add(rec.serviceTier);
      sourcesSeen.add(rec.source);

      const key = rec.model || "";
      const m =
        byModel[key] ||
        (byModel[key] = {
          input: 0,
          output: 0,
          cacheRead: 0,
          e5m: 0,
          e1h: 0,
        });
      m.input += rec.input;
      m.output += rec.output;
      m.cacheRead += rec.cacheRead;
      m.e5m += rec.e5m;
      m.e1h += rec.e1h;
      // If a record reports cache creation without the 5m/1h breakdown (older
      // transcripts), price the remainder at the 5m rate (API default TTL) so
      // creation cost isn't silently dropped.
      const splitKnown = rec.e5m + rec.e1h;
      if (rec.cacheCreation > splitKnown) {
        m.e5m += rec.cacheCreation - splitKnown;
      }
    }
  }

  const cacheableTotal = stats.cache_read_tokens + missBaselineTotal;
  stats.cache_hit_ratio =
    cacheableTotal > 0
      ? Number((stats.cache_read_tokens / cacheableTotal).toFixed(4))
      : null;
  stats.models = [...models];
  stats.service_tiers = [...tiers];
  stats.sources = [...sourcesSeen];
  stats.cost = computeCost(byModel);
  return stats;
}

// Resolve which transcript (chat) ids a tracking session owns, so usage can be
// attributed to exactly that chat rather than to every chat that happened to
// run in the same project folder during the window.
//
// Primary signal: the cache-manager tool calls recorded in each transcript
// (scanBindings) — a chat that called heartbeat/resume_or_start with this
// alias/session id declared itself the owner. `explicitIds` (Option A: an
// agent-supplied transcript id) are unioned in and always honoured.
//
// Returns { sessionIds: Set<string>, matched: [...], via: "binding"|"explicit"|
// "both"|"none" }. An EMPTY set is the fail-soft signal: the caller should then
// fall back to the unfiltered time+cwd behaviour (e.g. legacy sessions whose
// chats never called cache-manager), never to "zero usage".
export function resolveTranscriptSessionIds({
  cwd,
  windowStartMs,
  aliasNames = [],
  trackingSessionIds = [],
  explicitIds = [],
} = {}) {
  const wantAlias = new Set(aliasNames.filter(Boolean).map(String));
  const wantSession = new Set(trackingSessionIds.filter(Boolean).map(String));
  const resolved = new Set();
  const matched = [];

  for (const explicit of explicitIds.filter(Boolean).map(String)) {
    resolved.add(explicit);
    matched.push({ transcriptSessionId: explicit, via: "explicit" });
  }
  const explicitCount = resolved.size;

  for (const source of SOURCES) {
    if (typeof source.scanBindings !== "function") continue;
    let bindings;
    try {
      bindings = source.scanBindings({ cwd, windowStartMs });
    } catch {
      continue;
    }
    for (const b of bindings || []) {
      const aliasHit = [...b.aliases].some((a) => wantAlias.has(a));
      const sessionHit = [...b.sessionIds].some((s) => wantSession.has(s));
      if (!aliasHit && !sessionHit) continue;
      if (!resolved.has(b.transcriptSessionId)) {
        resolved.add(b.transcriptSessionId);
        matched.push({
          transcriptSessionId: b.transcriptSessionId,
          via: "binding",
          aliases: [...b.aliases],
        });
      }
    }
  }

  const bindingCount = resolved.size - explicitCount;
  const via =
    explicitCount && bindingCount
      ? "both"
      : explicitCount
        ? "explicit"
        : bindingCount
          ? "binding"
          : "none";
  return { sessionIds: resolved, matched, via };
}

// Render a compact human-readable summary suitable for appending to a memory.
export function formatStats(label, stats) {
  if (!stats || stats.turns === 0) {
    return `${label}: no transcript usage found in window.`;
  }
  const pct =
    stats.cache_hit_ratio === null
      ? "n/a"
      : `${(stats.cache_hit_ratio * 100).toFixed(1)}%`;
  const lines = [
    `${label}:`,
    `  turns=${stats.turns} input=${stats.input_tokens} output=${stats.output_tokens}`,
    `  cache: read=${stats.cache_read_tokens} creation=${stats.cache_creation_tokens} hit_ratio=${pct} cold_starts=${stats.cold_start_turns}`,
    `  ttl_split: 5m=${stats.ephemeral_5m_tokens} 1h=${stats.ephemeral_1h_tokens}`,
    `  models=${stats.models.join(",") || "n/a"}`,
  ];
  if (stats.cost) {
    const c = stats.cost;
    const h = c.hypothetical_high_miss;
    const mult = h.multiplier_vs_actual ? `${h.multiplier_vs_actual}x` : "n/a";
    lines.push(
      `  cost: $${c.estimated_usd} USD (if ${Math.round(h.miss_rate * 100)}% cache-miss: $${h.estimated_usd}, ${mult})`,
    );
    const perModel = c.by_model ? Object.entries(c.by_model) : [];
    if (perModel.length > 1) {
      lines.push(
        `  cost.by_model: ${perModel
          .map(([m, v]) => `${m}=$${v}`)
          .join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}
