# Agent Instructions

This project ships an MCP server named `cache_manager` that keeps per-chat
context so agents can resume cheaply across sessions.

## You probably don't need to copy anything

The server sends this workflow to your MCP client automatically via the
`instructions` field of the MCP `initialize` response, and reinforces it in each
tool's description. Conforming hosts (e.g. **Claude Code**, **Zed**) inject that
into the model's context, so the tool works **out of the box** — no setup in
your own `AGENTS.md` / `CLAUDE.md` required.

Only paste the snippet below into your `AGENTS.md` or `CLAUDE.md` if your MCP
client **ignores** server `instructions`.

## Minimal snippet (fallback)

```md
This workspace has an MCP server named `cache_manager`. Use it as follows:

1. RESUME — at the start of a chat, call `cache_manager.resume_or_start` with a
   stable `alias` (one per project/task). If the user didn't name a thread,
   derive a short kebab-case `alias` summarizing their first message (the task
   in ~2-4 words); if they didn't name a project, pass the working-directory
   basename as `project_group` (the server also defaults this for you if
   omitted). If it returns a memory, read it as restart context before anything
   else. If the response includes a `dashboard_url`, surface that localhost link
   to the user once so they can open the live web dashboard.
2. HEARTBEAT — every chat request must be bracketed by a matching pair of
   heartbeats; this is mandatory, not optional. At the very start of each chat
   request (a new user prompt), before other work, call
   `cache_manager.heartbeat` with `phase: "start"` so the dashboard shows the chat
   running. Immediately before your final response text — after all turns/tool
   calls answering that request — call `cache_manager.heartbeat` with
   `phase: "end"` so the idle/TTL countdown resumes. Never send your final
   response without a matching `phase: "end"`: a missing `end` leaves the chat
   falsely showing running when it is actually idle. This applies even when a
   request ends early — if you ask a clarifying question, hand off, or stop, still
   send `phase: "end"` first. Plain pings (`phase: "progress"`) after meaningful
   steps are optional. Feeds the external dashboard; not a checkpoint trigger.
3. CHECKPOINT at natural cut points — when you finish a substantial unit of work
   (a logical stopping point, usually the end of a long task), call
   `cache_manager.checkpoint` with a compact summary (goal, what changed,
   decisions, next steps). Do not checkpoint mid-task or merely because time has
   passed.
4. RESUME LATER — in a new chat, call `cache_manager.resume_or_start` with the
   same alias to restore the latest checkpoint.

TTL/idle are dashboard and cost-visibility metrics only — never a reason to
checkpoint. If the `cache_manager` tools are unavailable, say so and continue
without claiming memory or tracking is active.
```

See [`README.md`](README.md) for installation, the full tool reference, usage
stats, and the external dashboard/notifier.
