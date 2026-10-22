// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Builder model routing (#4394). The build runs on a mid-tier model when the frozen contract is small or touches only
 * docs, config and tests, and on the top model (the configured builder model, else the CLI default) when it is large or
 * hits a risk path (the built-in risk words or forge.yaml review.risk_paths). The route is computed once from the
 * contract's deliverable paths; a failed validate round on the mid tier escalates the lane to the top model.
 * Pure: no I/O, no model call. Repo-agnostic: paths are classified by extension and directory names only.
 */
import { riskClassOf, riskPathHits } from "./review-trigger.mjs";

export const ROUTING_MODES = Object.freeze(["on", "off"]);
export const DEFAULT_MID_MODEL = "claude-sonnet-5-5";
/** Deliverables of at most this many non-test files make a small change. */
export const SMALL_MAX_FILES = 2;
/** Fix-round triggers that are validate rounds: a failure on the mid tier escalates the lane to the top model. */
export const ESCALATE_TRIGGERS = Object.freeze(["precheck", "ci_red", "merge_ci"]);

const MODEL_RE = /^[A-Za-z0-9._:[\]-]+$/;

/** {mode, midModel}: an unknown mode is on, an invalid model id falls back to the default mid model. */
export function parseBuilderRouting({ mode, midModel } = {}) {
  const m = String(mode ?? "").trim().toLowerCase();
  const id = String(midModel ?? "").trim();
  return { mode: ROUTING_MODES.includes(m) ? m : "on", midModel: MODEL_RE.test(id) ? id : DEFAULT_MID_MODEL };
}

const LOCKFILE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|[^/]*\.lock)$/i;
const TEST_FILE_RE = /(\.(test|spec)\.[A-Za-z0-9]+$)|(_test\.(go|py|rb|exs?)$)|((^|\/)test_[^/]+\.py$)|(_spec\.rb$)|(Tests?\.(java|kt|cs|swift)$)/;
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|specs|fixtures|__snapshots__)\//i;
const DOCS_EXT_RE = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const DOCS_DIR_RE = /(^|\/)(docs?|devdocs)\//i;
const CONFIG_EXT_RE = /\.(json|jsonc|ya?ml|toml|ini|cfg|conf|properties|editorconfig)$/i;
const DOTFILE_RE = /(^|\/)\.[^/]+$/;
const ENV_EXAMPLE_RE = /(^|\/)\.env\.(example|sample|template)$/i;

/** 'test' | 'docs' | 'config' | 'code' for one repo-relative path. Lockfiles are code (they change what runs). */
export function classifyPath(p) {
  const s = String(p ?? "").trim().replace(/^\.\//, "");
  if (LOCKFILE_RE.test(s)) return "code";
  if (TEST_FILE_RE.test(s) || TEST_DIR_RE.test(s)) return "test";
  if (DOCS_EXT_RE.test(s) || DOCS_DIR_RE.test(s)) return "docs";
  if (ENV_EXAMPLE_RE.test(s) || CONFIG_EXT_RE.test(s) || DOTFILE_RE.test(s)) return "config";
  return "code";
}

/** Deliverable paths of a frozen contract (trimmed, unique, in order). */
export function deliverablePaths(contract) {
  const ds = Array.isArray(contract?.deliverables) ? contract.deliverables : [];
  return [...new Set(ds.map((d) => String(d?.path ?? "").trim()).filter(Boolean))];
}

/**
 * The route of one lane: {class, tier, model, risk}. class: risk | docs-config-test | small | large; tier: mid | top.
 * `topModel` null means the CLI default. Mode off keeps every lane on the top model but still reports its class.
 */
export function routeBuilder({ contract = null, riskPaths = [], cfg = {}, topModel = null } = {}) {
  const c = parseBuilderRouting(cfg);
  const paths = deliverablePaths(contract);
  const declared = new Set(riskPathHits(paths, riskPaths));
  const risk = paths.filter((p) => riskClassOf(p) || declared.has(p));
  const kinds = paths.map(classifyPath);
  const cls = !paths.length ? "large"
    : risk.length ? "risk"
      : kinds.every((k) => k !== "code") ? "docs-config-test"
        : kinds.filter((k) => k !== "test").length <= SMALL_MAX_FILES ? "small" : "large";
  const tier = c.mode === "on" && (cls === "docs-config-test" || cls === "small") ? "mid" : "top";
  return { mode: c.mode, class: cls, tier, model: tier === "mid" ? c.midModel : topModel, risk };
}

/** True when a failed `trigger` round on the mid tier escalates the lane (once). */
export function shouldEscalate(route, escalated, trigger) {
  return route?.tier === "mid" && !escalated && ESCALATE_TRIGGERS.includes(trigger);
}
