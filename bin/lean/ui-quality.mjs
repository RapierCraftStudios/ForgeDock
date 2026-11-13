// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * UI quality rules (#5330): every user-visible frontend change fits the platform's design system, and a new surface is
 * intuitive and polished. Deterministic: detection is by path and issue text, the rules are prompt text appended only to
 * UI lanes (base prompts stay inside their token caps), and the visual reviewer is the frontend domain check, not a new
 * agent call. A browser is never installed: the rendered self-check records why it could not run.
 */

const UI_FILE_RE = /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less)$|(?:^|\/)(?:web|app|components|pages|styles)\//i;
const TEST_FILE_RE = /\.(?:test|spec|stories)\.|(?:^|\/)(?:__tests__|e2e)\//i;
const UI_TEXT_RE = /\b(?:frontend|front-end|ui|ux|page|component|modal|dialog|button|layout|screen|dashboard|landing|css|tailwind|responsive|mobile view)\b|\.(?:tsx|jsx|vue|svelte)\b/i;
export const VISUAL_HEADING = "### Visual Check";

/** Changed or contracted non-test files that are user-visible UI (components, pages, styles). */
export const uiChanged = (files = []) => (Array.isArray(files) ? files : []).map(String).filter((f) => UI_FILE_RE.test(f) && !TEST_FILE_RE.test(f));

/** Whether the issue text or labels describe a user-visible frontend change (plan-time, before any file is known). */
export const uiIssue = ({ title = "", body = "", labels = [] } = {}) =>
  (labels ?? []).some((l) => /^(?:frontend|design|ui)$/i.test(String(l?.name ?? l))) || UI_TEXT_RE.test(`${title}\n${String(body).slice(0, 4000)}`);

/** design.system (forge.yaml): a path or list of paths naming the design system docs/tokens; [] when unset. */
export const designPaths = (cfg) => {
  const v = cfg?.system ?? cfg;
  return (Array.isArray(v) ? v : typeof v === "string" ? v.replace(/^\s*\[|\]\s*$/g, "").split(",") : []).map((x) => String(x).trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
};

/** The build rule: read the design system first, reuse it, and give every new surface its states. */
export function designSystemRule(cfg) {
  const paths = designPaths(cfg);
  const where = paths.length ? `Read the design system first: ${paths.join(", ")}.` : "Read the design system first: the paths in forge.yaml design.system, else the repo's design or token docs and the neighbouring components.";
  return `${where} Reuse existing components, tokens, spacing and type so the change fits the surrounding product; no off-system colours, fonts or spacing. A new surface must be intuitive: clear hierarchy, an obvious primary action, useful empty, loading and error states, and no placeholder boxes.`;
}

/** The self-check and gate rule; text for the builder only. */
export function uiSelfCheckRule() {
  return `Self-check before you commit: render the changed routes at desktop and mobile widths, compare them with neighbouring pages and fix alignment, spacing, truncation, contrast and state handling. Only use a browser that already exists; never install one. A new or rewritten page or route needs a design spec (route to /design) referenced in the contract. Record the result in implementation.md under "${VISUAL_HEADING}": the screenshot paths (before and after for an existing page), a verdict (consistent|inconsistent) and the fixes made, or "not rendered: <reason>" when no browser is available.`;
}

/** The conditional block appended to the plan and implement prompts of a UI lane; "" otherwise. */
export function uiBuildRule(on, cfg = null) {
  return on ? `\n\nUI change (user-visible frontend): ${designSystemRule(cfg)}\n${uiSelfCheckRule()}` : "";
}

/** The visual reviewer check, appended to DOMAIN_CHECKS.frontend (blocks as a regressions row). */
export const visualReviewCheck = () => "Visual/UX: open the screenshots listed in the PR's Visual check section (or render the route) and judge the change for intuitiveness, consistency with neighbouring pages and the design system, and polish; off-system colours, fonts or spacing, missing empty/loading/error states, placeholder boxes, and a UI change with no recorded visual check or screenshots (a new page also needs a /design spec) are findings.";

/** The PR body's "Visual check" section from implementation.md's "### Visual Check"; "" when absent or empty. */
export function visualSection(implementation) {
  const md = String(implementation ?? "");
  const i = md.indexOf(VISUAL_HEADING);
  if (i < 0) return "";
  const rest = md.slice(i + VISUAL_HEADING.length);
  const m = /\n#{1,3} /.exec(rest);
  const body = (m ? rest.slice(0, m.index) : rest).trim();
  return body ? `\n\n## Visual check\n${body}` : "";
}
