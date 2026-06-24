# Agent Instructions

This project includes an MCP context server named `cache_manager` for minimizing token usage across agent sessions by saving and restoring compact handoff memories.

## Hard preflight gate

At the very start of **every** new chat, before doing anything else, the agent's **first action must be to ask the user which cache-manager alias to use** (or call `cache_manager.list_aliases` and ask the user to choose one), then complete the startup workflow below. This applies to **every** request without exception — there is no "quick", "read-only", "informational", or "trivial" task that is exempt, and the nature of the request never justifies skipping it. Do not answer the question, inspect files, make edits, run validation, search the codebase, or provide any other response until the user has selected an alias (or explicitly declined) and `cache_manager.resume_or_start` has run.

If the `cache_manager` MCP tools are unavailable or fail, the agent must say so explicitly and continue without claiming memory, TTL tracking, countdowns, or notifications are active.

## Required startup workflow

At the start of every new agent session in this project:

1. Determine which alias/session to use.
   - If the user provides an `alias`, use it.
   - If the user provides a `session_id`, use it.
   - If no alias/session is provided, call `cache_manager.list_aliases` and show the known aliases to the user.
   - Ask the user to choose one of the listed aliases.
   - If the user declines to choose an existing alias, recommend a new project/task-specific alias such as `cache-manager-dev`, `cache-manager-native-notifications`, or another concise slug based on the current task.
   - Do not silently fall back to a hardcoded global default unless the user explicitly chooses it or this project rule provides it as the recommended default.
2. Restore restart context and start tracking in one call.
   - Prefer `cache_manager.resume_or_start` with the selected or newly recommended alias/session.
   - If `resume_or_start.memory_found` is true, read the returned memory content as restart context before making changes.
   - If no memory is found, continue normally but state that no prior memory was restored.
   - If `resume_or_start` is unavailable, fall back to `cache_manager.latest_memory` followed by `cache_manager.start_session`.

Suggested `resume_or_start` arguments:

```json
{
  "alias": "cache-manager-dev",
  "label": "Cache Manager project work",
  "ttl_seconds": 300,
  "warn_before_seconds": 45,
  "idle_seconds": 240
}
```

Use a more specific `session_id` or `alias` if the work clearly belongs to a different thread.

## TTL and inactivity policy

Use these defaults unless the user asks for different values:

- Prompt/session TTL: 5 minutes (`ttl_seconds: 300`).
- TTL warning window: 45 seconds (`warn_before_seconds: 45`).
- Inactivity threshold: 4 minutes (`idle_seconds: 240`).

Meaning of states:

- `active`: continue normally.
- `near_ttl`: create a compact checkpoint before doing more non-trivial work.
- `idle`: no heartbeat for 4 minutes; create a compact checkpoint or call heartbeat if work is still active.
- `expired`: the 5-minute TTL elapsed; checkpoint immediately, then do **not** continue substantive work in the same agent chat.

### What the countdown actually measures

The TTL countdown tracks wall-clock time since the last recorded activity — it is a proxy for how long the underlying prompt cache (Anthropic and OpenAI alike) has left before it ages out. Two consequences worth knowing:

- The countdown is only meaningful **after a complete response**. While a prompt is actively running, the model is reading the cache and keeping it warm; the dashboard suppresses the countdown (`▶ running`) during that window precisely because a countdown-toward-expiry would be misleading.
- The countdown **does not pause for a permission prompt**. A permission/confirmation wait makes no model request, so the cache ages exactly as it would during idle time, and the countdown keeps ticking. Prompt caching is wall-clock with refresh-on-use for both providers: the timer only resets when the next request reads the cached prefix, never while the agent is suspended waiting on you. Approve permission prompts promptly to keep the cache warm.

## Prompt after TTL expiry

Before answering a new user prompt when an existing cache-manager session may be stale, call `cache_manager.status` for the active alias/session.

If `status.expired` is true:

1. Create a compact checkpoint of the current durable restart context using `cache_manager.checkpoint`.
2. Do **not** continue substantive implementation, debugging, analysis, or guidance in this same agent chat.
3. Tell the user the prior TTL expired and that MCP cannot clear the current chat context or technically block AI-server calls.
4. Provide a simple copy/paste new agent chat bootstrap prompt that resumes the selected alias/session with `cache_manager.resume_or_start` and reads the latest memory before continuing.

Do not call `cache_manager.resume_or_start` and then keep working in the expired chat as if context were reset; starting a new MCP session only resets MCP timer state, not agent chat context.

## Turn lifecycle invariants (MANDATORY — read first)

These three rules are **hard requirements**, not guidance. They exist because the most common failure mode is the agent opening a turn and never closing it, which pins the dashboard on `running` and inflates `last_turn_ms`. The MCP server **cannot** observe request/response boundaries on its own — these invariants are agent-mediated and the agent is solely responsible for upholding them.

1. **Start/end pairing invariant.** Any turn opened with `heartbeat phase: "start"` **MUST** be closed with `heartbeat phase: "end"` in the *same response* that produces the final text. **Never leave a turn open across responses.** If you sent a `phase: "start"` this turn, you are required to send a matching `phase: "end"` before your final text — no exceptions.

2. **Always run a final heartbeat.** **Every** response ends with a `heartbeat` call immediately before the final response text — even when no `phase: "start"` was issued this turn. Use `phase: "end"` if a turn is open; otherwise send a plain `progress` ping. There is no such thing as a response that ends without a heartbeat.

3. **Self-check before responding.** Before sending final text, verify the turn state and explicitly close any open turn you own. If your last `heartbeat`/`status` showed `running: true` (a turn you opened), you **must** close it with `phase: "end"` before responding. Do not send final text while a turn you opened is still `running`.

Quick compliance checklist to run mentally before every final response:

- [ ] Did I open a turn this response (`phase: "start"`)? → I must close it with `phase: "end"` now (Rule 1).
- [ ] Is `running` currently true for a turn I own? → Close it with `phase: "end"` now (Rule 3).
- [ ] Regardless of the above, did I call a final `heartbeat` immediately before this text? → If not, call one now (Rule 2).

## Required ongoing workflow

During the session:

1. Before a long-running turn — one that will run tools, read/edit files, or otherwise take a while before you respond — call `cache_manager.heartbeat` with `phase: "start"` **first**, so the dashboard shows the chat as in-progress (`running`) with a live turn timer instead of letting it drift toward idle while you work.
2. Call `cache_manager.heartbeat` after **every chat interaction** so the latest TTL/idle metric is recorded.
3. Also call `cache_manager.heartbeat` (default `phase: "progress"`, which leaves turn state untouched) after meaningful intermediate actions, such as:
   - reading important files,
   - making edits,
   - running validation,
   - discovering a significant design constraint,
   - completing a task step.
4. At the end of **every** turn (this is mandatory — see "Turn lifecycle invariants" above), use this exact order:
   1. Call `cache_manager.heartbeat` first, immediately before final response text. Use `phase: "end"` if you opened a turn this response or a turn you own is still `running` (this closes the turn and freezes its duration); otherwise send a plain `progress` heartbeat. Either way, **a final heartbeat always runs** — no response ends without one (Rule 2), and no turn you opened is ever left open across responses (Rules 1 & 3).
   2. Only after that heartbeat, call `cache_manager.status` or `cache_manager.countdown` if an end-of-turn status/readout is needed.
   3. Then send final response text.
   4. Never call `status` or `countdown` as the final tool before final text unless `heartbeat` was called immediately before it in the same end-of-turn sequence.
5. Call `cache_manager.status` before long-running operations or when a response may take time.
6. Call `cache_manager.countdown` when a visible Agent Panel timer/status card is useful.
7. If `status`, `heartbeat`, or `countdown` returns `should_summarize: true`, immediately perform the handoff workflow below before continuing with non-trivial work.

### Turn-in-progress state

`heartbeat` accepts an optional `phase`:

- `phase: "start"` — opens a turn: marks the session `running` and starts a turn timer. Idempotent for a turn that is still live — re-starting keeps the original start time so the timer reflects total turn duration. If the prior turn is **stale** (no heartbeat for longer than the idle window, or older than the max-turn safety valve), `start` opens a fresh turn instead, so a forgotten `phase: "end"` can't carry a dead turn's start time into the next one.
- `phase: "progress"` (the default) — a plain activity ping that leaves turn state untouched. Every existing heartbeat call behaves this way.
- `phase: "end"` — closes the turn, freezes its duration as `last_turn_ms`, and resumes the normal TTL countdown. Per the mandatory **Turn lifecycle invariants** above, every `phase: "start"` must be matched by a `phase: "end"` in the same response — a turn must never be left open across responses, or the dashboard stays pinned on `running` and `last_turn_ms` is inflated by idle time between messages.

The computed `running` flag and `turn_elapsed_ms` (live while running, last turn's duration once ended) are returned by `status` and `countdown` and shown in the dashboard's `TURN` column. The live timer has **no idle/TTL ceiling** — a turn keeps counting for as long as it genuinely runs, so a long turn no longer drops the badge or resets the elapsed display ~5 min in. The only stop is a generous **max-turn safety valve** (default 60 min, override per session with `turn_max_seconds` on `start_session` / `resume_or_start`): a turn older than that is treated as a stuck/forgotten `phase: "end"` and self-heals back to non-running, so the badge is never pinned on forever and a real TTL expiry is never masked indefinitely.

Important heartbeat timing clarification:

- The current MCP server cannot independently observe when the user submits a request.
- Therefore, `heartbeat` is agent-mediated and should be called after the agent performs meaningful work and after every chat interaction.
- A heartbeat cannot run after the final response text has already been sent; the required final-turn heartbeat must be called immediately before final response text, and before any optional end-of-turn `status` or `countdown` readout.
- True request-submitted or response-completed heartbeats require future native host-client agent lifecycle hooks.

### Proactive checkpoint hint

Separately from the TTL/idle time-pressure of `should_summarize`, the server tracks how much work has accrued since the last checkpoint and raises a **checkpoint hint** when a handoff would be a cheap, natural move. The hint is driven purely by a cheap work counter and elapsed clock — it never parses transcripts on every ping and never acts on its own.

- `status.checkpoint_suggested` (boolean) and `status.checkpoint_reason` (string) appear on `status`, `heartbeat`, and `countdown`.
- It fires once **≥ 20 heartbeats** *or* **≥ 30 minutes** have elapsed since the last checkpoint (override per session with `checkpoint_after_actions` / `checkpoint_after_minutes` on `start_session` / `resume_or_start`).
- It is **suppressed** while a turn is `running` and while `should_summarize` is true (those states already drive a checkpoint recommendation), so it is never double-signalled.
- When it fires, the **`heartbeat` response bundles `checkpoint_suggestion`** = `{ reason, handoff_prompt, stats, stats_text, next_step }` — an example restart prompt plus freshly computed usage/cost stats — so you can checkpoint in one shot without separate `handoff_prompt` / `session_stats` calls. (Stats are computed only when the hint fires.)
- The hint **re-arms** automatically: `checkpoint` and `save_memory` reset the work counter.

A checkpoint can never be fully automatic — the memory needs a summary only the agent can write — so this is an **agent-triggered, one-call** checkpoint: the server nudges and pre-assembles everything; you still write the summary and make the call.

When `checkpoint_suggested` surfaces (and you are not under TTL/idle pressure), follow the handoff workflow below using the bundled `handoff_prompt` and `stats`.

## Quick `brb` command

When the user sends a prompt that is just **`brb`** (case-insensitive), or an obvious equivalent — `be right back`, `brb <duration>` (e.g. `brb 10`), `stepping away`, `back in a bit`, `afk` — treat it as an explicit **checkpoint-and-pause** command. The user is leaving and wants the conversation saved so it can be resumed in a fresh chat with minimal token cost.

On a `brb`:

1. **Do not start new substantive work.** Do not begin edits, analysis, or long tool runs. If a turn is in progress, finish only what is needed to leave a clean checkpoint.
2. **Checkpoint immediately.** Call `cache_manager.checkpoint` with the active alias/session, `restart_session: true` (default), and a compact durable summary (user goal, workspace, files changed, decisions, completed work, validation results, exact next steps). Keep it terse — optimize for cheap resume.
3. **Output the cost insights** returned by `checkpoint` (per-window token/cache stats and estimated USD) in the same response.
4. **Provide the copyable restart prompt** (use the `restart_prompt` returned by `checkpoint`, or the template below) so the user can paste it into a **new** chat when they return.
5. **Tell the user it is safe to step away**, and remind them that the prompt cache ages by wall-clock while idle — so the value of `brb` is that the checkpoint, not the live cache, is what preserves context. Resuming in a fresh chat is expected and intended.

Then end the turn normally (final `heartbeat` immediately before the response text, per the Turn lifecycle invariants).

Copyable restart prompt to include in the `brb` response:

```text
Resume cache-manager alias `<selected-alias>`.
Before doing anything else, call cache_manager.resume_or_start with {"alias":"<selected-alias>","label":"Resumed from checkpoint","ttl_seconds":300,"warn_before_seconds":45,"idle_seconds":240}; read any returned memory content as restart context, then continue with my next goal.
```

If a `session_id` is used instead of an alias, replace the `alias` field with `"session_id":"<selected-session-id>"`.

Note: `brb` is a convenience shortcut layered on top of the normal checkpoint/handoff workflow below — it is the same checkpoint, just triggered explicitly by the user instead of by TTL/idle pressure or a `should_summarize` hint.

## Proactive checkpoint and handoff workflow

Checkpoint after significant work even before TTL/idle warnings when it would materially reduce restart cost or cache misses. Use judgment, but prefer checkpointing after:

- important file reads or codebase discovery that should not need to be repeated,
- edits or configuration changes,
- validation runs and their results,
- architecture/design decisions,
- completing a multi-step task phase,
- before long responses that may consume substantial context,
- before or at `near_ttl`, `idle`, or `expired`.

When `should_summarize: true`:

1. Call `cache_manager.handoff_prompt` with the selected alias or session ID if summarization guidance is needed.
2. Use the returned prompt to write a compact restart summary.
3. Prefer `cache_manager.checkpoint` with that summary; it saves memory and starts a fresh TTL tracking session in one call by default.
4. Directly output the cost insights from `checkpoint` in the same turn as the summary request. If `checkpoint` is unavailable or does not return sufficient cost detail, call `cache_manager.session_stats` and include the relevant session/alias cost insights in the same turn.
5. Immediately after the cost insights, include a copyable prompt for continuing in a new agent chat/window.
6. If `checkpoint` is unavailable, fall back to `cache_manager.save_memory`, then start a fresh TTL tracking session if continuing work.
7. If TTL is expired or a context reset is required, do not continue substantive work in the same chat after saving the checkpoint; output the copy/paste new agent chat bootstrap prompt instead.

The summary should include only durable restart context:

- user goal,
- current project/workspace,
- files created or modified,
- important design decisions,
- completed work,
- validation commands and results,
- unresolved issues,
- exact next steps.

Avoid transcript-style detail. Optimize for a new session to resume with minimal tokens.

Copy/paste new agent chat prompt template after an expired TTL/context reset:

```text
Resume cache-manager alias `<selected-alias>`.
Before doing anything else, call cache_manager.resume_or_start with {"alias":"<selected-alias>","label":"Resumed from checkpoint","ttl_seconds":300,"warn_before_seconds":45,"idle_seconds":240}; read any returned memory content as restart context, then continue with: <next goal>.
```

If using a `session_id` instead of an alias, replace the `alias` field with `"session_id":"<selected-session-id>"`.

Suggested `checkpoint` arguments:

```json
{
  "alias": "cache-manager-dev",
  "title": "Cache Manager handoff",
  "summary": "<compact restart summary>",
  "tags": ["handoff", "cache-manager"],
  "restart_session": true
}
```

## Returning to an older chat/thread

If the user indicates they are returning to an older chat, continuing a prior thread, or asking which memory belongs to this thread:

1. If the user provides or the prior context contains a likely `alias`, first call `cache_manager.latest_memory` with that `alias`.
2. If a likely `session_id` is known, call `cache_manager.latest_memory` with that `session_id`.
3. If neither is known, call `cache_manager.list_aliases` and/or `cache_manager.search_memories` using project names, feature names, user-provided hints, or likely keywords.
4. If multiple plausible memories are found, ask the user to choose before treating one as authoritative context.
5. After selecting a memory, read it as restart context and start/continue TTL tracking with the resolved alias or session ID.

Useful restore calls:

```json
{ "alias": "cache-manager-dev" }
```

```json
{ "session_id": "cache-manager-dev" }
```

```json
{ "query": "cache manager extension", "limit": 5 }
```

Because most MCP clients do not expose a native chat/thread ID to MCP servers, exact old-chat matching depends on stable aliases, stable session IDs, or searchable memory metadata.

## Usage stats and cost

`cache_manager.session_stats` reports transcript-derived token/cache usage and an estimated USD cost for the tracking session and the alias's whole lifetime. Use it when the user asks how many tokens or how much money a conversation has spent, how effective prompt caching has been, or for a usage readout before/after a long run.

Call it with the selected alias (optionally `scope`: `session` | `alias` | `both`, default `both`):

```json
{ "alias": "cache-manager-dev" }
```

There is no shared identifier between a cache-manager session and an agent transcript, so the bridge is purely by **time window**: `current_session` covers the tracking session's start to now; `alias_lifetime` covers the alias's `created_at` to now.

Transcript sources are pluggable; Claude Code transcripts (scoped to the project `cwd`) are the only source today. A project-scoped call reports Claude Code usage for that project; pass `all_projects: true` to aggregate across all projects.

Each window reports `turns`, input/output tokens, `cache_read_tokens` / `cache_creation_tokens`, `cache_hit_ratio`, `cold_start_turns`, the 5m/1h cache-creation split, `models`, and a `cost` block.

The `cost` block gives `estimated_usd` (priced per model and summed) plus a `hypothetical_high_miss` scenario that re-prices 90% of cache reads at the full input rate — "what this would have cost if the cache had mostly missed." Pricing uses USD list-price defaults (as of 2026-06) and can be overridden by setting `CACHE_MANAGER_PRICING` (a JSON object keyed by model id) for the MCP server process.

`checkpoint` automatically appends a compact version of these numbers — including a `cost:` line per window — to the saved memory under a `=== USAGE STATS (transcript-derived) ===` block, so spend travels with restart context. Disable by passing `include_stats: false` (or `append_stats_to_memory: false` to keep stats in the payload but out of the memory file).

## Copy/paste chat bootstrap prompt

If you want to make the behavior more likely in a specific chat, start the chat with this message:

```text
Before doing anything else, follow this project's cache-manager preflight gate:
1. If I have not provided an alias/session, call cache_manager.list_aliases and ask me to choose one. If I decline, recommend a new project/task-specific alias.
2. Call cache_manager.resume_or_start with {"alias":"<selected-or-new-alias>","label":"Cache Manager project work","ttl_seconds":300,"warn_before_seconds":45,"idle_seconds":240}; read any returned memory content as restart context.
3. If resume_or_start is unavailable, fall back to cache_manager.latest_memory followed by cache_manager.start_session.
4. During this chat, call cache_manager.heartbeat after every chat interaction and after meaningful work. At the end of every turn, first call cache_manager.heartbeat immediately before final response text; only after that heartbeat, call cache_manager.status or cache_manager.countdown if an end-of-turn status/readout is needed; then send final response text. Never call status/countdown as the final tool before final text unless heartbeat was called immediately before it in the same end-of-turn sequence.
5. Call cache_manager.status before long-running work or possible stale prompts, and call cache_manager.countdown when a visible Agent Panel timer is useful.
6. Checkpoint after significant work and whenever should_summarize is true by calling cache_manager.handoff_prompt if needed, summarizing compact durable restart context, and calling cache_manager.checkpoint with restart_session=true. Whenever a summary is requested, directly output cost insights in the same turn, then provide a copyable prompt to continue in a new agent chat/window.
7. If TTL is expired or context reset is required, do not continue substantive work in this same chat after checkpointing. Provide a copy/paste prompt for a new agent chat instead.
Only proceed with my actual request after completing steps 1-3 or after telling me the cache-manager tools are unavailable.
```

## Native notification limitation

The current `countdown` tool is request-driven: it displays timer state when an agent calls it. It does **not** independently trigger a native client notification, run a background timer, or mount a continuously ticking status widget.

Native notifications require future host-client support for extension notifications, status items, agent lifecycle hooks, or MCP server-originated notifications.

Do not claim that native notifications are active unless the host client exposes such an API and this server/extension has implemented it.

## Memory location

By default, saved memories are stored at:

```text
~/.cache/cache-manager-mcp/memories/
```

Session state is stored at:

```text
~/.cache/cache-manager-mcp/sessions.json
```

Alias mappings are stored at:

```text
~/.cache/cache-manager-mcp/aliases.json
```

The base directory can be overridden by setting `CACHE_MANAGER_STORE_DIR` for the MCP server process.

## Memory retention

Handoff memories are pruned automatically so they do not accumulate forever. The server prunes on startup, and the same logic is exposed as the `cache_manager.prune_memories` tool for on-demand cleanup (pass `dry_run: true` to preview).

The default policy keeps the newest memory per alias (so `resume_or_start`/`latest_memory` can always restore a thread) and deletes any non-latest memory older than 30 days. Defaults are configurable via `CACHE_MANAGER_RETENTION_DAYS` (default 30, `0` disables age pruning), `CACHE_MANAGER_KEEP_LATEST_PER_ALIAS` (default true), and `CACHE_MANAGER_PRUNE_ON_STARTUP` (default true). `prune_memories` also accepts `delete_non_latest: true` to keep only the latest memory per alias regardless of age.
