#!/usr/bin/env node
// Per-chat cost attribution: the `sessionIds` filter on aggregateUsage and the
// resolveTranscriptSessionIds binding resolver. All hermetic — we point
// CACHE_MANAGER_TRANSCRIPT_DIR at a temp dir of hand-written transcripts so the
// test never touches the real ~/.claude/projects logs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const checks = [];

// Build a hermetic Claude-Code transcript root for `cwd`, writing one .jsonl per
// chat. Each chat is { id, turns:[{...usage}], calls:[{alias?,session_id?}] };
// `calls` become recorded cache_manager tool_use blocks (the ownership signal).
function writeTranscripts(cwd, chats) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm-attribution-tx-"));
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-");
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now() - 60000;
  for (const chat of chats) {
    const lines = [];
    for (const call of chat.calls || []) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(base).toISOString(),
          cwd,
          sessionId: chat.id,
          message: {
            model: "claude-opus-4-8",
            content: [
              {
                type: "tool_use",
                name: "cache_manager.heartbeat",
                input: call,
              },
            ],
          },
        }),
      );
    }
    for (const usage of chat.turns || []) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(base).toISOString(),
          cwd,
          sessionId: chat.id,
          message: { model: "claude-opus-4-8", usage },
        }),
      );
    }
    fs.writeFileSync(path.join(dir, `${chat.id}.jsonl`), `${lines.join("\n")}\n`);
  }
  return root;
}

const usage = (output) => ({
  input_tokens: 10,
  output_tokens: output,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 100,
  cache_creation: { ephemeral_5m_input_tokens: 100 },
});

const cwd = "/tmp/cm-attribution-project";
const root = writeTranscripts(cwd, [
  // chatA declares alias "alpha"; chatB declares alias "beta"; chatC is an
  // untracked chat in the same folder that called nothing.
  { id: "chatA", calls: [{ alias: "alpha" }], turns: [usage(100), usage(100)] },
  { id: "chatB", calls: [{ session_id: "beta-sid" }], turns: [usage(50)] },
  { id: "chatC", turns: [usage(999)] },
]);
process.env.CACHE_MANAGER_TRANSCRIPT_DIR = root;

const { aggregateUsage, resolveTranscriptSessionIds } = await import(
  "../server/transcript-stats.mjs"
);

const win = { windowStartMs: 0, windowEndMs: Date.now(), cwd };

// 1. No filter = current behaviour: every chat in the cwd counted.
const all = aggregateUsage(win);
checks.push([all.turns === 4, `no filter counts all 4 turns (got ${all.turns})`]);

// 2. sessionIds filter restricts to the named chats only.
const onlyA = aggregateUsage({ ...win, sessionIds: new Set(["chatA"]) });
checks.push([onlyA.turns === 2, `filter to chatA -> 2 turns (got ${onlyA.turns})`]);
const onlyB = aggregateUsage({ ...win, sessionIds: new Set(["chatB"]) });
checks.push([onlyB.turns === 1, `filter to chatB -> 1 turn (got ${onlyB.turns})`]);

// 3. Empty set is treated as "no filter" (back-compat / fail-soft guard).
const emptyFilter = aggregateUsage({ ...win, sessionIds: new Set() });
checks.push([
  emptyFilter.turns === 4,
  `empty set behaves like no filter (got ${emptyFilter.turns})`,
]);

// 4. Resolver binds an alias to the chat that declared it, by tool-call signal.
const rAlpha = resolveTranscriptSessionIds({
  cwd,
  windowStartMs: 0,
  aliasNames: ["alpha"],
  trackingSessionIds: ["alpha"],
});
checks.push([
  rAlpha.via === "binding" && rAlpha.sessionIds.has("chatA") && rAlpha.sessionIds.size === 1,
  `resolve alpha -> {chatA} via binding (got via=${rAlpha.via} ids=${[...rAlpha.sessionIds]})`,
]);

// 5. Resolver matches on tracking session_id recorded in the tool input too.
const rBeta = resolveTranscriptSessionIds({
  cwd,
  windowStartMs: 0,
  trackingSessionIds: ["beta-sid"],
});
checks.push([
  rBeta.sessionIds.has("chatB") && rBeta.sessionIds.size === 1,
  `resolve beta-sid -> {chatB} (got ${[...rBeta.sessionIds]})`,
]);

// 6. Non-overlap: alpha and beta bind to disjoint chats; chatC belongs to none.
const overlap = [...rAlpha.sessionIds].filter((id) => rBeta.sessionIds.has(id));
checks.push([overlap.length === 0, `alpha/beta bindings are disjoint`]);
checks.push([
  !rAlpha.sessionIds.has("chatC") && !rBeta.sessionIds.has("chatC"),
  `untracked chatC is bound to nobody`,
]);

// 7. Fail-soft: an alias nobody declared resolves to an empty set + via "none".
const rNone = resolveTranscriptSessionIds({
  cwd,
  windowStartMs: 0,
  aliasNames: ["ghost"],
  trackingSessionIds: ["ghost"],
});
checks.push([
  rNone.via === "none" && rNone.sessionIds.size === 0,
  `unknown alias -> empty set, via none (got via=${rNone.via} size=${rNone.sessionIds.size})`,
]);

// 8. Option A explicit ids are unioned in and honoured even without a tool call.
const rExplicit = resolveTranscriptSessionIds({
  cwd,
  windowStartMs: 0,
  aliasNames: ["alpha"],
  explicitIds: ["chatC"],
});
checks.push([
  rExplicit.sessionIds.has("chatA") &&
    rExplicit.sessionIds.has("chatC") &&
    rExplicit.via === "both",
  `explicit chatC + bound chatA -> both, union (got via=${rExplicit.via} ids=${[...rExplicit.sessionIds]})`,
]);

// 9. End-to-end: attributing alpha's usage counts only chatA's two turns, not
//    chatC's noisy 999-output turn that shares the folder.
const alphaUsage = aggregateUsage({ ...win, sessionIds: rAlpha.sessionIds });
checks.push([
  alphaUsage.turns === 2 && alphaUsage.output_tokens === 200,
  `alpha attribution excludes other chats (turns=${alphaUsage.turns} output=${alphaUsage.output_tokens})`,
]);

const failed = checks.filter(([ok]) => !ok);
if (failed.length > 0) {
  for (const [, message] of failed) console.error(`FAILED: ${message}`);
  process.exit(1);
}
console.log("smoke attribution test passed");
