/**
 * Codec for the single machine-readable FORGE:STATE HTML-comment block on an
 * issue body. Carries the COMPACT INDEX only (no rich per-phase outputs).
 */
const OPEN = "<!-- FORGE:STATE";
const CLOSE = "-->";
const BLOCK_RE = /<!-- FORGE:STATE\s*([\s\S]*?)-->/;

/** @param {import("./phases.mjs").RunState} index */
export function serializeState(index) {
  const payload = JSON.stringify(index).replace(/-->/g, "--&gt;");
  return `${OPEN}\n${payload}\n${CLOSE}`;
}

/** @returns {import("./phases.mjs").RunState|null} */
export function parseState(issueBody) {
  const m = BLOCK_RE.exec(issueBody || "");
  if (!m) return null;
  try { return JSON.parse(m[1].trim().replace(/--&gt;/g, "-->")); } catch { return null; }
}

/** Replace the FORGE:STATE block in place, or append one if absent. */
export function upsertStateBlock(body, index) {
  const block = serializeState(index);
  if (BLOCK_RE.test(body || "")) return body.replace(BLOCK_RE, () => block);
  return `${body || ""}\n\n${block}`.trimStart();
}
