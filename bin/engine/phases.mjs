/**
 * Declarative phase table for the headless work-on pipeline. The ENGINE (not an
 * LLM) chooses the next phase via pickPhase. Each phase's outcome is read from
 * GitHub/git AFTER the run (detectOutcome); the runner's return is advisory.
 * @typedef ... (see plan "Shared types")
 */

export const TERMINAL_REASONS = ["merged", "invalid", "needs-human", "decomposed"];

/** Fetch the issue's comment bodies as one blob for marker checks. */
async function issueMarkers(issue, io) {
  const out = await io.gh(["api", `repos/{owner}/{repo}/issues/${issue}/comments`, "--jq", ".[].body"]);
  return out || "";
}
/**
 * Count commits on branch ahead of the lane base. On the first build the
 * branch does not exist yet, so real git rejects the ref range — swallow
 * that (and any other git failure) as "0 ahead" rather than letting it
 * propagate and crash runIssue (C1).
 */
async function commitsAhead(state, io) {
  try {
    const n = await io.git(["rev-list", "--count", `origin/${state.lane}..${state.branch}`]);
    return parseInt(String(n).trim(), 10) || 0;
  } catch {
    return 0;
  }
}
function has(blob, marker) { return blob.includes(marker); }

/** @type {Phase[]} */
export const PHASES = [
  {
    id: "investigate",
    command: "work-on/investigate",
    entryCondition: () => true,
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      if (has(m, "INVESTIGATION:INVALID"))
        return { status: "committed", terminalReason: "invalid", outputs: { verdict: "INVALID" } };
      if (has(m, "DECOMPOSE:YES"))
        return { status: "committed", terminalReason: "decomposed", outputs: { decompose: true } };
      if (has(m, "INVESTIGATION:COMPLETE"))
        return { status: "committed", outputs: { verdict: "CONFIRMED" } };
      return { status: "failed", detail: "no INVESTIGATION:COMPLETE marker" };
    },
    isTerminalAfter: (s) => s.terminalReason === "invalid" || s.terminalReason === "decomposed",
  },
  {
    id: "context",
    command: "work-on/build/context",
    entryCondition: (s) => s.committed.includes("investigate"),
    async reconcile(state, io) {
      // Idempotent resume: FORGE:CONTEXT:COMPLETE present → skip the LLM re-run.
      // Bare FORGE:CONTEXT matches a partial/interrupted annotation — require :COMPLETE.
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:CONTEXT:COMPLETE") ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      // Context is non-critical: a missing marker is a VISIBLE skip, not a hard fail (spec §7).
      if (has(m, "FORGE:CONTEXT")) return { status: "committed", outputs: {} };
      return { status: "committed", outputs: { skipped: true, which: "context" } };
    },
  },
  {
    id: "architect",
    command: "work-on/build/architect",
    entryCondition: (s) => s.committed.includes("context"),
    async reconcile(state, io) {
      // Idempotent resume: FORGE:ARCHITECT:COMPLETE present → skip the LLM re-run.
      // Bare FORGE:ARCHITECT matches a partial/interrupted annotation — require :COMPLETE.
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:ARCHITECT:COMPLETE") ? { satisfied: true } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      return has(m, "FORGE:ARCHITECT:COMPLETE")
        ? { status: "committed", outputs: {} }
        : { status: "failed", detail: "no FORGE:ARCHITECT:COMPLETE" };
    },
  },
  {
    id: "build",
    command: "work-on/build",
    entryCondition: (s) => s.committed.includes("architect"),
    async reconcile(state, io) {
      // Idempotent resume: branch already ahead of base → treat as done, skip the LLM.
      if (state.branch && (await commitsAhead(state, io)) > 0) {
        const m = await issueMarkers(state.issue, io);
        if (has(m, "FORGE:BUILDER:COMPLETE")) return { satisfied: true, outputs: { branch: state.branch } };
      }
      return { satisfied: false };
    },
    async detectOutcome(state, io) {
      const m = await issueMarkers(state.issue, io);
      const complete = has(m, "FORGE:BUILDER:COMPLETE");           // #1305: require :COMPLETE …
      const ahead = state.branch ? await commitsAhead(state, io) : 0; // … AND real commits
      if (complete && ahead > 0) return { status: "committed", outputs: { branch: state.branch } };
      return { status: "failed", detail: `builder complete=${complete} commitsAhead=${ahead}` };
    },
  },
  {
    id: "review",
    command: "work-on/review",
    entryCondition: (s) => s.committed.includes("build"),
    async reconcile(state, io) {
      const pr = await openPrFor(state, io);   // adopt an existing PR instead of opening a second
      return pr ? { satisfied: false, outputs: { pr } } : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const pr = await prStatusFor(state, io);
      if (!pr) return { status: "failed", detail: "no PR created" };
      if (pr.merged) return { status: "committed", outputs: { pr: pr.number } };
      if (pr.needsHuman) return { status: "blocked", detail: "review escalated", outputs: { pr: pr.number } };
      return { status: "failed", detail: "PR open, not merged" };
    },
  },
  {
    id: "close",
    command: "work-on/close",
    entryCondition: (s) => s.committed.includes("review"),
    async reconcile(state, io) {
      // Idempotent resume: issue already closed or workflow:merged label set → skip the LLM re-run.
      const out = await io.gh(["issue", "view", String(state.issue), "--json", "state,labels"]);
      let j;
      try { j = JSON.parse(out || "{}"); } catch { return { satisfied: false }; }
      const labels = (j.labels || []).map((l) => l.name || l);
      return (j.state === "CLOSED" || labels.includes("workflow:merged"))
        ? { satisfied: true }
        : { satisfied: false };
    },
    async detectOutcome(state, io) {
      const out = await io.gh(["issue", "view", String(state.issue), "--json", "state,labels"]);
      let j;
      try { j = JSON.parse(out || "{}"); } catch { return { status: "failed", detail: "malformed gh response" }; }
      const labels = (j.labels || []).map((l) => l.name || l);
      if (j.state === "CLOSED" || labels.includes("workflow:merged"))
        return { status: "committed", terminalReason: "merged", outputs: {} };
      return { status: "failed", detail: "issue not closed" };
    },
    isTerminalAfter: () => true,
  },
];

async function openPrFor(state, io) {
  if (!state.branch) return null;
  const out = await io.gh(["pr", "list", "--head", state.branch, "--json", "number", "--state", "all"]);
  try { const a = JSON.parse(out || "[]"); return a[0]?.number ?? null; } catch { return null; }
}
async function prStatusFor(state, io) {
  const n = await openPrFor(state, io);
  if (!n) return null;
  const out = await io.gh(["pr", "view", String(n), "--json", "number,state,labels,mergedAt"]);
  let j;
  try { j = JSON.parse(out || "{}"); } catch { return null; }
  const labels = (j.labels || []).map((l) => l.name || l);
  return { number: j.number, merged: !!j.mergedAt || j.state === "MERGED",
           needsHuman: labels.includes("needs-human") };
}

/** The engine's transition function: first uncommitted phase whose gate holds. */
export function pickPhase(state) {
  if (state.terminal) return null;
  for (const p of PHASES) {
    if (state.committed.includes(p.id)) continue;
    if (p.entryCondition(state)) return p;
  }
  return null;
}
