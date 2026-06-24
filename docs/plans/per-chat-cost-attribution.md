# Plan: Per-chat cost attribution (bind usage to transcript sessionId)

## Problem

The dashboard's TURNS / TOKENS / COST / SAVINGS tally is computed by **time
window + project directory** only (`[alias created → now]` filtered by `cwd`),
with **no link to a specific chat's transcript**. Consequence: every alias row
counts *every* assistant turn that occurred in that project folder during its
window — including turns from other chats and even untracked Claude Code
sessions in the same directory.

### Evidence (measured 2026-06-23)

Six aliases share `cwd = /Users/dannyma/Code/personal-projects/cache-manager`:

| | turns | cost |
|---|---|---|
| claude-test | 1526 | $170.70 |
| countdown-dashboard | 1106 | $98.40 |
| zed-reference-removal | 1043 | $92.99 |
| log-cleanup | 703 | $55.45 |
| running-status-update | 615 | $49.54 |
| update-project-details | 296 | $24.05 |
| **Sum of rows** | **5289** | **$491.13** |
| **Distinct truth (each turn once)** | **1609** | **$178.08** |

Summing the column overcounts **2.76×**. Each row is internally consistent
(matches `session_stats`) but over-attributes: it is not "what this one chat
cost." Earliest alias ≈ whole-project spend; later aliases re-count a suffix.

## Goal

Make each tracking session's tally reflect **only the turns from the chat(s)
that actually belong to that tracking session**, so per-row numbers are exact
and non-overlapping across aliases in the same project.

## Root cause

`server/transcript-stats.mjs` bridges by time+cwd. Each Claude Code transcript
is one file named by its `sessionId` (UUID), and every assistant line carries
that `sessionId`. `parseLine` already extracts it as `transcriptSessionId`
(line 117) but `collect`'s `records.push` (line ~156) drops it, so it can't be
used as a filter. There is currently no stored mapping from a cache-manager
tracking session → its Claude Code transcript sessionId(s).

## Key constraint (the hard part)

The MCP server cannot directly observe the caller's Claude Code transcript
sessionId — see the "Limitation" note in AGENTS.md / CLAUDE.md ("cannot know
native chat thread IDs"). So the binding has to be either **supplied** by the
agent or **inferred** by the server. This plan recommends inference as the
robust default, with explicit binding as an optional precision override.

## Approach options

### Option A — Explicit binding (precise, but needs the agent to know its ID)
Agent passes `transcript_session_id` into `start_session` / `resume_or_start` /
`heartbeat`; server stores it on the session record. Exact, but only works if
the agent can reliably obtain its own transcript UUID.
- **OPEN QUESTION / SPIKE REQUIRED:** can a Claude Code agent obtain its current
  transcript sessionId (env var, `--print` metadata, a known file)? If not,
  Option A is infeasible and we rely on B.

### Option B — Inference by timestamp correlation (recommended default)
The server already records `actions: [{ at, action }]`, plus `started_at_ms` /
`last_action_at_ms`, for each tracking session. At stats time:
1. List candidate transcripts in the session's `cwd` overlapping the window.
2. For each candidate transcript (= one chat), score how well its assistant-line
   timestamps cluster around this session's recorded action timestamps.
3. Bind the transcript(s) whose activity best matches; attribute only their
   turns. Persist the resolved `transcript_session_ids` on the session record so
   the match is stable (compute once, then reuse — important for frozen/expired
   rows and for cache cheapness).
- No agent changes; self-contained. Heuristic, but dramatically better than the
  time+cwd union. Needs a tie-break rule for concurrent chats in one folder.

### Option C — Claim-on-first-activity (rejected)
Claim the first transcript with a new assistant line after `start_session` in
the cwd. Fragile under concurrent chats / resumes; not recommended.

**Recommendation:** Implement B as the default. Add A as an optional override
*only if* the spike shows the transcript ID is reliably obtainable; an
explicitly-supplied ID always wins over inference.

## Implementation steps

1. **Carry the id through the collector.** In `transcript-stats.mjs`, add
   `transcriptSessionId` to the object pushed in `collect` (line ~156) so it
   survives aggregation.
2. **Add a `sessionIds` filter to `aggregateUsage`.** Optional `Set<string>`;
   when present, skip records whose `transcriptSessionId` isn't in the set.
   Keep time+cwd as the candidate pre-filter (cheap), then apply the id filter.
   When `sessionIds` is absent, behaviour is unchanged (back-compat).
3. **Add a resolver** `resolveTranscriptSessionIds(session)` (new fn, likely in
   transcript-stats.mjs or a small sibling) implementing Option B's correlation
   scoring. Returns the matched id set + a confidence/score for transparency.
4. **Persist the binding.** Store `transcript_session_ids` on the session record
   (written by `start_session` / `resume_or_start` / `heartbeat`, and resolved
   lazily in `computeSessionStats` if absent). Frozen/expired sessions resolve
   once and reuse.
5. **Wire `computeSessionStats`** (`cache-manager.mjs` ~line 981) to pass the
   resolved `sessionIds` into both `aggregateUsage` calls (current + alias).
6. **Optional Option A:** accept `transcript_session_id` arg on the tracking
   tools; if provided, store it and let it override inference.
7. **Dashboard:** no structural change — it calls the same path via
   `usageForSession`. Numbers tighten automatically. Update the footnote: once
   attribution is exact, drop / soften the "overlapping aliases double-count"
   warning (or keep a reduced caveat for the inference-confidence case).
8. **Decide aggregate semantics:** with exact attribution, an "all sessions in
   project" total becomes meaningful (distinct). Consider a summary line that
   sums rows safely.

## Files to modify

- `server/transcript-stats.mjs` — carry `transcriptSessionId`; add `sessionIds`
  filter to `aggregateUsage`; add correlation resolver.
- `server/cache-manager.mjs` — store/resolve `transcript_session_ids`; pass to
  `aggregateUsage` in `computeSessionStats`; optional explicit-id arg on tools.
- `server/cache-manager-dashboard.mjs` — footnote/labels only (logic unchanged).
- `scripts/smoke-dashboard.mjs` + a transcript-stats unit test — see below.

## Risks / considerations

- **Inference accuracy under concurrency.** Two chats in one folder at the same
  time are the worst case. Define an explicit tie-break (e.g. assign each turn to
  the single best-scoring session; never to multiple) so rows stay
  non-overlapping by construction.
- **Resumed sessions span multiple transcript files.** A tracking session that
  was checkpointed/restarted may legitimately own several transcript UUIDs —
  the binding must be a SET, not a single id.
- **Back-compat.** Old session records have no binding and possibly bad/no `cwd`
  (`/`, none). Resolver must fail soft to the current time+cwd behaviour and the
  dashboard must still render `—` where appropriate.
- **Performance.** Resolution parses candidate transcripts; do it on the slow
  usage cadence and cache/persist the resolved id set (don't redo every render).
- **Don't break the invariant.** Dashboard must keep agreeing with
  `session_stats` — both must consume the same resolver + filter.

## Acceptance criteria

- [x] Spike resolves Option A feasibility (transcript id obtainable? **YES** —
      `CLAUDE_CODE_SESSION_ID` env holds the transcript UUID and matches the
      `<uuid>.jsonl` file; the agent can pass it in, the server can't read it
      from its own env. Implemented as an optional explicit override).
- [x] `aggregateUsage` accepts an optional `sessionIds` filter; absent = current
      behaviour (regression-safe). Empty set also treated as absent (fail-soft).
- [x] For the 6-alias `cache-manager` cluster, per-row costs become
      non-overlapping and **sum to $170.48 (was $491)** — the ~$7.6 gap to the
      $178 distinct truth is the 4 chats (79 turns) that never called
      cache-manager and so can't be bound.
- [x] Resumed/multi-transcript sessions attribute across all their owned files
      (binding is a Set; e.g. claude-test → 5 chats, update-project-details → 4).
- [x] Sessions with no/odd cwd still render `—`; no crashes; fail-soft (unknown
      alias → empty set → unfiltered time+cwd fallback, flagged `~`).
- [x] Dashboard still matches `session_stats` for every row (both consume the
      same `resolveTranscriptSessionIds` + `sessionIds` filter path). Critical
      detail: agents record cache-manager calls with the ALIAS, never the raw
      session_id, so `computeSessionStats` reverse-looks-up the alias from
      `session.id` — without it a `session_id`-only stats call would bind to
      nothing and silently fall back to the overcounted total. Pinned by a
      `smoke-mcp.mjs` regression asserting alias-path and session_id-path
      resolve identical bound transcripts.
- [x] New unit test (`scripts/smoke-attribution.mjs`, 9 checks) for the
      `sessionIds` filter + binding resolver; `scripts/smoke-dashboard.mjs`
      Case 4 added (exact bind excludes noise, `~` fallback); all smoke green.

## Implementation notes (as built)

- **Stronger-than-planned binding signal.** Rather than timestamp correlation,
  the resolver reads the `cache_manager` tool calls each transcript *recorded*
  (`scanBindings`): a chat that heartbeated with alias X declared itself X's
  owner. Deterministic, no concurrency tie-break, the 50-action cap is moot.
  Timestamp correlation was not needed; fail-soft to time+cwd is the fallback.
- **Resolution is computed fresh, not persisted to `sessions.json`** (only the
  explicit Option A ids are stored). The dashboard caches per-row usage on its
  slow cadence and freezes expired rows, so re-scanning isn't a hot path;
  persisting inferred ids would risk staleness for still-active sessions.
- Files changed: `server/transcript-stats.mjs`, `server/cache-manager.mjs`,
  `server/cache-manager-dashboard.mjs`, `scripts/smoke-dashboard.mjs`,
  `scripts/smoke-attribution.mjs` (new), `package.json`, `Makefile`.

## Out of scope

- Changing pricing tables or the cache hit-ratio / hypothetical-miss math.
- Cross-project aggregation.

---
_Authored 2026-06-23. Prerequisite work already shipped: dashboard TURNS /
TOKENS / COST / SAVINGS columns + flexible alias width (alias `update-dashboard`)._
