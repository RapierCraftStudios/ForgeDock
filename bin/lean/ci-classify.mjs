// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { INFRA_SIGNATURES, signatureHash } from "./release-flakes.mjs";

/** #5690: deterministic CI failure impact classifier (parent #5687). Pure: no I/O, the caller passes the flake ledger. */
export const CI_CLASSES = ["deterministic-setup", "generated-artifact-stale", "infra", "flaky-suspect", "code"];
export const DOWNSTREAM_CLASSES = ["deterministic-setup", "generated-artifact-stale"];
export const FAIL_FAST_POLICIES = ["off", "deterministic"];

/** Setup failures that break every downstream job. Kept narrow: a false setup class on a code failure cancels good jobs. */
export const SETUP_SIGNATURES = [
  ["command-not-found", /(?:^|[\s:])(?:[\w./-]+: )?(?:command not found|not found in PATH)|executable file not found in \$?PATH|is not recognized as an internal or external command|exec: "[^"]+": executable file not found/im],
  ["missing-package", /npm ERR! 404 .*Not Found|ERR_PNPM_FETCH_404|ERR_PNPM_NO_MATCHING_VERSION|No matching distribution found for|Could not find a version that satisfies the requirement|ModuleNotFoundError: No module named '(?:pip|setuptools|wheel)'|go: (?:module )?\S+: reading \S+: 404|cannot find package "\S+" in any of|package \S+ is not in (?:GOROOT|std)/i],
  ["package-config", /ERESOLVE|ERR_PNPM_(?:INVALID_|BAD_|UNSUPPORTED_ENGINE|UNEXPECTED_STORE|NO_PKG_MANIFEST)\w*|npm ERR! code (?:EUSAGE|E401|E403|EJSONPARSE|EBADENGINE)|npm ERR! (?:Invalid|Unsupported) |npm ERR! missing script|Unknown (?:env )?config "?\S+"?|\.npmrc/i],
  ["lockfile-mismatch", /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_\w+|`npm ci` can only install packages when your package\.json and package-lock\.json|lockfile .* (?:needs to be updated|not up to date|out of sync)|Cannot install with "frozen-lockfile"|uv\.lock .* (?:out of date|needs to be updated)|poetry\.lock is not up to date|pyproject\.toml changed significantly since poetry\.lock|updates to go\.(?:mod|sum) needed|go\.sum: missing|missing go\.sum entry/i],
  ["image-pull", /manifest unknown|pull access denied|Error response from daemon: (?:manifest|pull access|Get ")|failed to pull image|ErrImagePull|ImagePullBackOff|repository does not exist|toomanyrequests: You have reached your pull rate limit|failed to resolve source metadata for|no matching manifest for/i],
  ["setup-permission", /(?:EACCES|Permission denied)[^\n]*(?:node_modules|\.npm|\.cache|\.pnpm-store|\/usr\/(?:local\/)?(?:bin|lib)|site-packages|\.cargo|\/opt\/|\/home\/runner\/work\/_temp|docker\.sock|go\/pkg\/mod)/i],
];

/** Generated artifacts out of date (diff-after-generate, drift checks). */
export const STALE_SIGNATURES = [
  ["out-of-date-run", /(?:is|are|was|were)? ?(?:out of date|out-of-date|stale)[^\n]*\b(?:run|regenerate|re-run|rerun)\b|\b(?:run|regenerate)\b[^\n]*(?:to update|to regenerate|to fix)|please (?:run|regenerate)\b[^\n]*(?:and commit|again)|generated files? (?:are|is) (?:out of date|not up to date|stale)|(?:schema|snapshot|types?|openapi|docs|client|bindings|codegen)[^\n]*(?:out of date|not up to date|drift|stale)/i],
  ["diff-after-generate", /(?:working tree|git diff|repository|tree) (?:is )?(?:not clean|dirty|has (?:uncommitted )?changes|differs)[^\n]*(?:after|generat|codegen)|(?:after|following) (?:running )?(?:generate|codegen|make gen)[^\n]*(?:diff|changes|modified|dirty)|files? (?:changed|modified) after (?:generat|build|codegen)|generated .* (?:differ|changed|not committed)|uncommitted changes (?:detected )?after (?:generat|codegen|build)/i],
  ["drift-check", /(?:^|\b)(?:drift detected|drift check failed|schema drift|migration drift|api drift|openapi drift)\b|(?:check[-_ ]generated|verify[-_ ]generated|check[-_ ]drift|codegen[-_ ]check)\b[^\n]*(?:fail|error|differ|diff)|Files? differ(?:ing)? from (?:committed|generated)|differs from the committed/i],
];

const MAX_SIG = 200;
/** First meaningful error line, digits and hex collapsed, so a re-run of the same failure hashes the same. */
function codeSignature(lines, test) {
  const all = [test?.message, ...lines].filter((l) => typeof l === "string");
  const hit = all.find((l) => /\b(?:error|assert\w*|fail\w*|expected|exception|panic|TS\d{4}|E\d{3,4})\b/i.test(l)) ?? all.find((l) => l.trim()) ?? "";
  return hit.trim().toLowerCase().replace(/0x[0-9a-f]+|\b[0-9a-f]{7,40}\b/g, "H").replace(/\d+/g, "N").replace(/\s+/g, " ").slice(0, MAX_SIG);
}

const firstHit = (table, text) => table.find(([, re]) => re.test(text))?.[0] ?? null;

/**
 * `{step, lines, test, flakes}` -> `{class, signature, downstream}`. `flakes` is the ledger list (release-flakes `readFlakes`).
 * Order: setup, stale, infra, then a ledger hit overrides a would-be `code`. A test failure never classes as setup/stale: its
 * output is the test's own, and e.g. a bad import in code would look like a missing module.
 */
export function classifyCiFailure({ step, lines, test, flakes } = {}) {
  const ls = Array.isArray(lines) ? lines.filter((l) => typeof l === "string") : [];
  const text = [...ls, test?.message ?? ""].join("\n");
  const out = (cls, signature) => ({ class: cls, signature, downstream: DOWNSTREAM_CLASSES.includes(cls) });
  if (!test) {
    const setup = firstHit(SETUP_SIGNATURES, text);
    if (setup) return out("deterministic-setup", setup);
    const stale = firstHit(STALE_SIGNATURES, text);
    if (stale) return out("generated-artifact-stale", stale);
  }
  const infra = firstHit(INFRA_SIGNATURES, text);
  if (infra) return out("infra", infra);
  const sig = codeSignature(ls, test);
  if (Array.isArray(flakes) && flakes.length) {
    const h = signatureHash(step ?? "", test?.id ?? null, sig);
    if (flakes.some((f) => f?.signature_hash === h)) return out("flaky-suspect", sig);
  }
  return out("code", sig);
}

/** `fail_fast` from a forge.yaml `ci` block or a bare string; anything but `deterministic` is `off`. */
export const failFastPolicy = (policy) => { const v = typeof policy === "string" ? policy : policy?.fail_fast; return v === "deterministic" ? "deterministic" : "off"; };

/**
 * Decision only: `{action:"cancel"|"continue", reason}`. Cancelling is done by the subscriber (the #5687 lane consumer), never by the router.
 * Only a downstream class under policy `deterministic` returns `cancel`.
 */
export function failFastDecision(event, policy) {
  const cls = event?.class ?? (event && (event.type === "step_failed" || event.type === "test_failed") ? classifyCiFailure(event).class : null);
  if (failFastPolicy(policy) !== "deterministic") return { action: "continue", reason: "fail_fast off" };
  if (DOWNSTREAM_CLASSES.includes(cls)) return { action: "cancel", reason: `${cls} breaks every downstream job` };
  return { action: "continue", reason: `class ${cls ?? "none"} is not downstream` };
}
