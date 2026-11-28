// Gap audit of an active pipeline/env/pool failure (#6078): opt-in (forge.yaml orchestrate.lane_audit.file_gaps, default off) engine-gap issue per signature with a count and the affected lanes.
import { findFiledIssues } from "./filed-issue.mjs";
export const GAP_CLASSES = Object.freeze(["pipeline", "env", "pool"]);
export const DEFAULT_GAP = Object.freeze({ fileGaps: false, repo: "RapierCraftStudios/ForgeDock", label: "engine-gap" });

/** forge.yaml (parsed) -> gap config; the parser may nest (`orchestrate.lane_audit.x`) or flatten. Only the string "true" enables. */
export function parseGapConfig(yaml) {
  const o = yaml?.orchestrate && typeof yaml.orchestrate === "object" ? yaml.orchestrate : {};
  const s = { ...o, ...(o.lane_audit && typeof o.lane_audit === "object" ? o.lane_audit : {}) };
  const out = { ...DEFAULT_GAP };
  const f = s.file_gaps ?? s.lane_audit_file_gaps;
  out.fileGaps = f !== undefined && String(f).trim().toLowerCase() === "true";
  const repo = String(s.repo ?? s.lane_audit_repo ?? "").trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) out.repo = repo;
  const label = String(s.label ?? s.lane_audit_label ?? "").trim();
  if (/^[\w. :-]+$/.test(label)) out.label = label;
  return out;
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strip what must not reach the engine repo (#6020): the lane's own repo, any owner/name, absolute paths. */
export function redactGap(text, { repo = "" } = {}) {
  let t = String(text ?? "");
  const [, name] = String(repo).split("/");
  if (repo) t = t.replace(new RegExp(esc(repo), "gi"), "<repo>");
  if (name && name.length > 2) t = t.replace(new RegExp(`(?<![\\w.-])${esc(name)}(?![\\w.-])`, "gi"), "<repo>");
  t = t.replace(/(?:[A-Za-z]:\\|~\/|\/)[\w.@+~-]+(?:[\\/][\w.@+~ -]*)+/g, "<path>");
  t = t.replace(/(?<![\w.-])[\w.-]+\/[\w.-]+(?![\w.-])/g, "<repo>");
  return t;
}

const lanesOf = (body) => [...new Set([...(/Affected lanes:\s*([^\n]*)/.exec(body)?.[1] ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
const render = ({ sig, c, count, lanes, version, repo }) => `<!-- forge-gap: ${sig} -->\n**Engine gap** \`${sig}\`\n\n- Class: ${redactGap(c.class, { repo })}\n- Owner: ${redactGap(c.owner ?? "-", { repo })}\n- Action: ${redactGap(c.action ?? "-", { repo })}\n- Engine version: ${redactGap(version ?? "-", { repo })}\n- Occurrences: ${count}\n- Affected lanes: ${lanes.map((n) => `#${n}`).join(", ")}\n`;

/**
 * Build the gap seam for runLaneAudit: async (bundle, classified) -> {issue, count, action} | null. Never throws.
 * @param {{gh: Function, cfg?: object, repo?: string}} o
 */
export function makeGapAuditor({ gh, cfg = DEFAULT_GAP, repo = "" } = {}) {
  return async (bundle, classified = null) => {
    try {
      const c = classified;
      if (!cfg?.fileGaps || typeof gh !== "function" || !c || !c.active || c.fixed_in_later || !GAP_CLASSES.includes(c.class) || !c.signature) return null;
      const sig = String(c.signature), marker = `<!-- forge-gap: ${sig} -->`, lane = Number(bundle?.issue);
      if (!Number.isSafeInteger(lane)) return null;
      const version = bundle?.stamp?.engine_version ?? null;
      const found = (await findFiledIssues({ ghc: gh, repo: cfg.repo, key: marker }))[0]; // #6238: state all, local marker filter
      if (found && String(found.state).toUpperCase() !== "OPEN") await gh(["issue", "reopen", String(found.number), "--repo", cfg.repo]);
      if (found) {
        const lanes = lanesOf(String(found.body));
        if (lanes.includes(lane)) return { issue: found.number, count: lanes.length, action: "unchanged" };
        lanes.push(lane);
        await gh(["issue", "edit", String(found.number), "--repo", cfg.repo, "--body", render({ sig, c, count: lanes.length, lanes, version, repo })]);
        return { issue: found.number, count: lanes.length, action: "update" };
      }
      const out = String(await gh(["issue", "create", "--repo", cfg.repo, "--label", cfg.label, "--title", `engine-gap: ${redactGap(sig, { repo })} (${c.class})`, "--body", render({ sig, c, count: 1, lanes: [lane], version, repo })]));
      const n = Number(out.match(/(\d+)\s*$/)?.[1]);
      return Number.isSafeInteger(n) ? { issue: n, count: 1, action: "create" } : null;
    } catch { return null; }
  };
}

/** Default seam: no gap finding. @param {object} bundle the evidence bundle of lane-audit.mjs  @param {object} [classified] the signature match, when any */
export async function auditGap(bundle, classified = null) { // eslint-disable-line no-unused-vars
  return null;
}
