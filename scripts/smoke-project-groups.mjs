#!/usr/bin/env node
// Smoke test for alias project groups + per-group savings aggregation.
//
// Part A (pure): groupRowsByProject() buckets rows by their project group,
// sums alias-lifetime cost + savings per bucket, defaults missing/null groups
// to "Ungrouped" (back-compat with pre-feature aliases.json), and orders named
// groups alphabetically with Ungrouped last.
//
// Part B (integration): a project_group written into aliases.json is threaded
// through buildRows() onto each row as `projectGroup`, so the dashboards can
// group on it. Env is set BEFORE the dynamic import so dashboard-data.mjs picks
// up the hermetic store.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "cache-manager-groups-store-"),
);
process.env.CACHE_MANAGER_STORE_DIR = storeDir;
// Point transcripts at an empty dir so usage resolves to zero, not the real
// project totals — Part B only asserts the projectGroup threading.
process.env.CACHE_MANAGER_TRANSCRIPT_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "cache-manager-groups-transcripts-"),
);

const { groupRowsByProject, buildRows } = await import(
  "../server/dashboard-data.mjs"
);

// --- Part A: pure grouping + subtotal logic -------------------------------
function row(alias, projectGroup, cost, savings) {
  return {
    alias,
    projectGroup,
    usage: {
      alias: {
        cost: {
          estimated_usd: cost,
          hypothetical_high_miss: { extra_usd: savings },
        },
      },
    },
  };
}

const rows = [
  row("api", "Acme", 1.0, 4.0),
  row("web", "Acme", 2.0, 6.0),
  row("infra", "Beta", 0.5, 1.5),
  row("scratch", null, 0.25, 0.75), // no group -> Ungrouped
  row("legacy", undefined, 0.1, 0.2), // pre-feature alias -> Ungrouped
];

const groups = groupRowsByProject(rows);
const byName = new Map(groups.map((g) => [g.group, g]));

// Three buckets: Acme, Beta, Ungrouped.
assert.equal(groups.length, 3, "expected three project-group buckets");
assert.ok(byName.has("Acme") && byName.has("Beta") && byName.has("Ungrouped"));

// Per-group savings subtotal = sum of member sessions' alias-lifetime savings.
assert.equal(byName.get("Acme").savings, 10.0, "Acme savings = 4 + 6");
assert.equal(byName.get("Acme").cost, 3.0, "Acme cost = 1 + 2");
assert.equal(byName.get("Beta").savings, 1.5, "Beta savings");
assert.equal(
  byName.get("Ungrouped").savings,
  0.95,
  "Ungrouped savings = 0.75 + 0.2 (null + undefined groups)",
);
assert.equal(byName.get("Acme").rows.length, 2, "Acme has two members");
assert.equal(byName.get("Ungrouped").rows.length, 2, "Ungrouped has two");

// Ordering: named groups alpha, Ungrouped always last.
assert.deepEqual(
  groups.map((g) => g.group),
  ["Acme", "Beta", "Ungrouped"],
  "named groups alpha, Ungrouped last",
);

// Rows with no usage must not crash and contribute 0.
const noUsage = groupRowsByProject([{ alias: "x", projectGroup: "Z" }]);
assert.equal(noUsage[0].savings, 0, "missing usage contributes 0 savings");
assert.equal(noUsage[0].cost, 0, "missing usage contributes 0 cost");

// Empty input -> empty grouping, no throw.
assert.deepEqual(groupRowsByProject([]), [], "empty rows -> empty groups");

// Subtotals must count EVERY member of a group, including expired/collapsed
// sessions — the savings of an old expired chat is still real savings for that
// project. (The web dashboard collapses old expired *cards* but must keep them
// in the subtotal; this asserts the helper never drops a member.) Two expired +
// one active in one group; subtotal = sum of all three.
const withExpired = [
  { ...row("live", "Gamma", 1.0, 3.0), expired: false },
  { ...row("old1", "Gamma", 0.5, 2.0), expired: true },
  { ...row("old2", "Gamma", 0.5, 5.0), expired: true },
];
const gamma = groupRowsByProject(withExpired)[0];
assert.equal(gamma.rows.length, 3, "expired members stay in the group");
assert.equal(gamma.savings, 10.0, "subtotal counts expired members (3+2+5)");
assert.equal(gamma.cost, 2.0, "cost subtotal counts expired members (1+.5+.5)");

// --- Part B: project_group threaded from aliases.json into buildRows() ----
const now = Date.now();
fs.writeFileSync(
  path.join(storeDir, "aliases.json"),
  JSON.stringify({
    "grouped-alias": {
      alias: "grouped-alias",
      session_id: "grouped-alias",
      title: "Grouped",
      project_group: "Acme",
      created_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 60000).toISOString(),
    },
    // Pre-feature record with no project_group at all.
    "old-alias": {
      alias: "old-alias",
      session_id: "old-alias",
      title: "Legacy",
      created_at: new Date(now - 60000).toISOString(),
      updated_at: new Date(now - 60000).toISOString(),
    },
  }),
);
fs.writeFileSync(
  path.join(storeDir, "sessions.json"),
  JSON.stringify({
    "grouped-alias": session("grouped-alias", now),
    "old-alias": session("old-alias", now),
  }),
);

function session(id, ts) {
  return {
    id,
    label: id,
    ttl_ms: 300000,
    warn_before_ms: 45000,
    idle_ms: 240000,
    started_at_ms: ts - 30000,
    ttl_anchor_ms: ts - 30000,
    last_action_at_ms: ts - 30000,
    started_at: new Date(ts - 30000).toISOString(),
    last_action_at: new Date(ts - 30000).toISOString(),
    cwd: "/tmp/cache-manager-groups-smoke-project",
    actions: [],
  };
}

const built = buildRows();
const byAlias = new Map(built.map((r) => [r.alias, r]));
assert.equal(
  byAlias.get("grouped-alias")?.projectGroup,
  "Acme",
  "project_group threaded onto row",
);
assert.equal(
  byAlias.get("old-alias")?.projectGroup ?? null,
  null,
  "pre-feature alias has null projectGroup (no crash)",
);

// And grouping the real rows buckets the ungrouped one under Ungrouped.
const builtGroups = groupRowsByProject(built);
const builtNames = builtGroups.map((g) => g.group);
assert.ok(builtNames.includes("Acme"), "Acme bucket from real rows");
assert.ok(builtNames.includes("Ungrouped"), "Ungrouped bucket from real rows");

console.log("Project groups smoke test passed");
