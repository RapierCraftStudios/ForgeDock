// Shared fixtures for engine tests (forge#3542): realistic, trusted, anchored issue comments in the
// shape `gh api --paginate .../comments --jq '.[] | {body, author_association, user:{type,login}} | @json'`
// emits. A "markers" world string is a SEP-delimited list of comment bodies.
export const SEP = "\u0001";

/** A trusted-author comment object (default OWNER). Override with {assoc, type, login}. */
export const trusted = (body, { assoc = "OWNER", type = "User", login = "maintainer" } = {}) =>
  ({ body, author_association: assoc, user: { type, login } });

/** One JSON object per line, as `gh --paginate --jq '... | @json'` prints. */
export const jsonLines = (objs) => objs.map((o) => JSON.stringify(o)).join("\n");

/** Convert a SEP-delimited markers string into the gh output engine code reads (all OWNER-authored). */
export const asComments = (markers) =>
  jsonLines(String(markers).split(SEP).map((b) => b.trim()).filter(Boolean).map((b) => trusted(b)));

export const invBody = (verdict = "COMPLETE", { decompose = false, quote = "" } = {}) =>
  `<!-- FORGE:INVESTIGATOR -->\n## Investigation Report\n\n**Verdict**: ${verdict === "INVALID" ? "INVALID" : "CONFIRMED"}\n${quote}\n` +
  `### Decomposition Assessment\n**${decompose ? "YES" : "NO"}** — reason\n\n<!-- INVESTIGATION:${verdict} -->`;
export const inv = (verdict, opts) => SEP + invBody(verdict, opts);
export const ctx = () => SEP + "<!-- FORGE:CONTEXT -->\n## Context\n<!-- FORGE:CONTEXT:COMPLETE -->";
export const arch = () => SEP + "<!-- FORGE:ARCHITECT -->\n## Plan\n<!-- FORGE:ARCHITECT:COMPLETE -->";
export const builderBody = (branch) =>
  `<!-- FORGE:BUILDER -->\n## Implementation Complete\n${branch ? `**Branch**: \`${branch}\`\n` : ""}<!-- FORGE:BUILDER:COMPLETE -->`;
export const builder = (branch) => SEP + builderBody(branch);
export const remediationBody = (outcome) =>
  `<!-- FORGE:REMEDIATION -->\n**Re-gate outcome**: ${outcome}\n<!-- FORGE:REMEDIATION:COMPLETE -->`;
export const remediation = (outcome) => SEP + remediationBody(outcome);
export const decomposed = () => SEP + "<!-- FORGE:DECOMPOSED -->\nspawned\n<!-- FORGE:DECOMPOSED:COMPLETE -->";
