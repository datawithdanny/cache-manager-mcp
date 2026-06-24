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
   stable `alias` (one per project/task). If it returns a memory, read it as
   restart context before anything else. If the response includes a
   `dashboard_url`, surface that localhost link to the user once so they can
   open the live web dashboard.
2. HEARTBEAT — at the start of each chat request (a new user prompt), call
   `cache_manager.heartbeat` with `phase: "start"` so the dashboard shows the chat
   running. When you finish answering that request (after all turns/tool calls),
   call `cache_manager.heartbeat` with `phase: "end"` immediately before your final
   response text so the idle/TTL countdown resumes. Plain pings (`phase:
   "progress"`) after meaningful steps are optional. Feeds the external
   dashboard; not a checkpoint trigger.
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
