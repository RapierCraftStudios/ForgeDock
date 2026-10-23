// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Explorer subagent (#4391): the builder does its discovery (greps, reads, call chains) through a cheap custom subagent
 * (`claude --agents`) in a throwaway context that returns a bounded file/line digest, so the expensive main session keeps
 * the conclusion instead of re-reading every discovered byte on each later turn. Opt-in via forge.yaml `lean.explore: on`
 * (default off: builder argv and prompts are unchanged); RUN_TERMINAL carries `explore` so the on/off A/B is a query.
 */

export const EXPLORER_NAME = "explorer";
export const DEFAULT_EXPLORE_MODEL = "haiku";
const MODEL_RE = /^[A-Za-z0-9._:[\]-]+$/;

/** {mode, model} from forge.yaml lean.explore / lean.explore_model; anything but "on" is off, an invalid model is the default. */
export function parseExploreConfig(raw = {}) {
  const mode = String(raw?.mode ?? "").trim().toLowerCase() === "on" ? "on" : "off";
  const m = String(raw?.model ?? "").trim();
  return { mode, model: MODEL_RE.test(m) ? m : DEFAULT_EXPLORE_MODEL };
}

export const EXPLORER_PROMPT = `You explore a code repository for a developer who will edit it. You are read-only: never edit or write files, never commit, push or change GitHub state. Use Bash only for read commands (git log/show/diff/grep, ls, gh ... view).

Answer the question you were given with ONE digest of at most 60 lines (about 6 KB). Every claim carries path:line; never paste whole files or long excerpts. Use exactly these sections, writing "none" for an empty one:
### Files   (path:start-end: why it is relevant)
### Call sites   (path:line: caller -> callee)
### Tests to extend   (test path and test name, and the exact command that runs only that test)
### Conventions to match   (naming, error handling, helpers to reuse, each with a path:line example)
### Open questions   (what you could not determine, and where to look)`;

/** The `--agents` object for the builder session, or null when off (argv unchanged). */
export function explorerAgents(cfg) {
  if (cfg?.mode !== "on") return null;
  return { [EXPLORER_NAME]: { description: "Read-only code explorer: answers one focused question about the repository with a bounded file/line digest (files with line ranges, call sites, tests to extend, conventions).",
    prompt: EXPLORER_PROMPT, tools: ["Read", "Grep", "Glob", "Bash"], model: cfg.model } };
}

const RULE = `do discovery (greps, file reads, following call chains) by calling the Agent tool with subagent_type "${EXPLORER_NAME}" and one focused question per call, and keep its digest as your notes. Open a file yourself only to edit it or to verify a digest claim.`;

/** Plan-prompt rule; "" when off (prompt unchanged). */
export function explorePlanRule(cfg) {
  return cfg?.mode === "on" ? `\n\nExploration: ${RULE} Verify any digest claim the contract relies on before citing it.` : "";
}

/** Implement-prompt rule; "" when off (prompt unchanged). */
export function exploreBuildRule(cfg) {
  return cfg?.mode === "on" ? `\n\nExploration: for anything the plan's digests do not cover, ${RULE}` : "";
}
