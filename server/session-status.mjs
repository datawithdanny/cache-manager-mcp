// Shared TTL/idle status math for the cache-manager MCP server and the
// background countdown dashboard. Kept side-effect free so it can be imported
// by both without triggering stdio/transport setup. This is the single source
// of truth for the countdown: anything that displays it must import from here
// rather than re-deriving the numbers (which would silently drift).

export const DEFAULT_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_WARN_BEFORE_MS = 45 * 1000;
export const DEFAULT_IDLE_MS = 4 * 60 * 1000;

// Safety valve for the live turn timer. A turn is "running" purely on its
// stored flag with NO idle/TTL ceiling, so the elapsed timer counts correctly
// for arbitrarily long turns. The only stop is this generous bound: a turn
// whose start is older than this is treated as a stuck/forgotten phase:"end"
// and self-heals back to a non-running state. Set high enough that no real
// turn reaches it, so in practice there is no ceiling.
export const DEFAULT_MAX_TURN_MS = 60 * 60 * 1000;

// Work-volume thresholds for the proactive checkpoint *hint*. This is a nudge
// — orthogonal to should_summarize (which is TTL/idle time-pressure). It fires
// once a decent chunk of work has accrued since the last checkpoint so a
// handoff stays cheap; it never acts on its own (the agent still writes the
// summary and makes the call).
export const DEFAULT_CHECKPOINT_AFTER_ACTIONS = 20;
export const DEFAULT_CHECKPOINT_AFTER_MS = 30 * 60 * 1000;

export function nowMs() {
  return Date.now();
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Agent-facing guidance. Checkpointing is driven by work-item boundaries (the
// agent's judgment + the work-volume `checkpoint_suggested` nudge), NOT by TTL.
// TTL/idle (near_ttl/expired/idle/should_summarize) remain in the status object
// for the external dashboard, notifier, and severity coloring, but they are no
// longer surfaced to the agent as a reason to checkpoint.
export function recommendationForStatus(status) {
  if (status.running) {
    return "A turn is in progress. Keep calling heartbeat after meaningful steps; call heartbeat with phase 'end' immediately before the final response text.";
  }
  if (status.checkpoint_suggested) {
    return `A substantial chunk of work has accrued since the last checkpoint (${status.checkpoint_reason}). If you've just finished a coherent unit of work, this is a good cut point — call cache-manager.checkpoint with a compact summary. Otherwise keep going. The heartbeat response already includes an example restart prompt and usage/cost stats for this stage.`;
  }
  return "Continue. Call heartbeat at the end of each turn (it keeps the dashboard current). Checkpoint when you finish a substantial unit of work so the next session can resume cheaply. TTL/idle are dashboard-only and not a checkpoint trigger.";
}

// Compute the live TTL/idle status for a stored session record. The TTL is a
// sliding window anchored to `ttl_anchor_ms` (reset on every heartbeat), NOT a
// fixed countdown from session start — so the remaining time resets to the full
// TTL each heartbeat.
export function sessionStatus(session) {
  const now = nowMs();
  const ttlAnchorMs = session.ttl_anchor_ms ?? session.started_at_ms;
  const expiresAt = ttlAnchorMs + session.ttl_ms;
  const timeRemainingMs = expiresAt - now;
  const idleMs = now - session.last_action_at_ms;
  const idleRemainingMs = session.idle_ms - idleMs;
  const nearTtl = timeRemainingMs <= session.warn_before_ms;
  const expired = timeRemainingMs <= 0;
  const idle = idleMs >= session.idle_ms;
  const shouldSummarize = expired || nearTtl || idle;

  // Explicit turn-in-progress state. Driven by heartbeat phase:"start"/"end".
  // The live timer has NO idle/TTL ceiling: the dashboard reads this without
  // heartbeating, so gating `running` on !idle/!expired used to make any turn
  // longer than the idle window (~4-5 min) silently drop the badge AND reset
  // the elapsed display to the previous turn's stale duration. Instead, a turn
  // is running purely on its stored flag, bounded only by a generous max-turn
  // safety valve. A turn that outruns that bound is a stuck/forgotten
  // phase:"end" and self-heals back to non-running (the write side also resets
  // a stale turn's start time on the next phase:"start" so it can't poison a
  // fresh turn's elapsed).
  const turn = session.turn;
  const maxTurnMs = session.turn_max_ms ?? DEFAULT_MAX_TURN_MS;
  const turnAgeMs = turn?.running ? now - turn.started_at_ms : null;
  const running = Boolean(turn?.running) && turnAgeMs < maxTurnMs;
  const turnElapsedMs = running ? turnAgeMs : (session.last_turn_ms ?? null);

  // Proactive checkpoint hint. Driven purely by work volume since the last
  // checkpoint — a cheap counter and elapsed clock, NOT transcript parsing — so
  // it is safe to evaluate on every heartbeat. Kept separate from
  // should_summarize: that is time-pressure (you must checkpoint soon), this is
  // a "now is a cheap moment to hand off" nudge. Suppressed mid-turn (running)
  // and while under TTL/idle pressure, since those states already drive a
  // checkpoint recommendation and shouldn't be double-signalled.
  const checkpointAnchorMs =
    session.last_checkpoint_at_ms ?? session.started_at_ms;
  const sinceCheckpointMs = now - checkpointAnchorMs;
  const actionsSinceCheckpoint = session.actions_since_checkpoint ?? 0;
  const checkpointAfterActions =
    session.checkpoint_after_actions ?? DEFAULT_CHECKPOINT_AFTER_ACTIONS;
  const checkpointAfterMs =
    session.checkpoint_after_ms ?? DEFAULT_CHECKPOINT_AFTER_MS;
  const byActions = actionsSinceCheckpoint >= checkpointAfterActions;
  const byTime = sinceCheckpointMs >= checkpointAfterMs;
  const checkpointSuggested =
    !running && !shouldSummarize && (byActions || byTime);
  const checkpointReason = checkpointSuggested
    ? [
        byActions
          ? `${actionsSinceCheckpoint} actions since last checkpoint`
          : null,
        byTime ? `${formatDuration(sinceCheckpointMs)} since last checkpoint` : null,
      ]
        .filter(Boolean)
        .join("; ")
    : null;

  const severity = running
    ? "running"
    : expired
      ? "expired"
      : nearTtl && idle
        ? "ttl_and_idle"
        : nearTtl
          ? "near_ttl"
          : idle
            ? "idle"
            : "ok";

  const status = {
    session_id: session.id,
    label: session.label,
    ttl_ms: session.ttl_ms,
    warn_before_ms: session.warn_before_ms,
    idle_ms: session.idle_ms,
    started_at: session.started_at,
    last_action_at: session.last_action_at,
    checked_at: nowIso(),
    expires_at: new Date(expiresAt).toISOString(),
    elapsed_ms: now - session.started_at_ms,
    time_remaining_ms: Math.max(0, timeRemainingMs),
    idle_for_ms: idleMs,
    idle_remaining_ms: Math.max(0, idleRemainingMs),
    near_ttl: nearTtl,
    expired,
    idle,
    running,
    turn_started_at: running ? turn.started_at : (turn?.started_at ?? null),
    turn_elapsed_ms: turnElapsedMs,
    last_turn_ms: session.last_turn_ms ?? null,
    should_summarize: shouldSummarize,
    actions_since_checkpoint: actionsSinceCheckpoint,
    since_checkpoint_ms: sinceCheckpointMs,
    checkpoint_suggested: checkpointSuggested,
    checkpoint_reason: checkpointReason,
    severity,
    alert: idle
      ? `No heartbeat has been recorded for ${formatDuration(idleMs)}. Create a compact checkpoint or call heartbeat if work is still active.`
      : null,
  };
  status.recommendation = recommendationForStatus(status);
  return status;
}
