#!/usr/bin/env node

/**
 * Compact, deterministic preflight for OpenCode orchestration.
 *
 * The shared orchestration specs remain authoritative for the complete
 * workflow. This module only handles the mechanical work needed before the
 * first native task can start: issue resolution, eligibility filtering, basic
 * dependency edges, and the initial ready queue.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInputPattern } from "./engine/resolve.mjs";

const VERSION = "opencode-preflight-v1";
const IN_FLIGHT_LABELS = new Set(["workflow:building", "workflow:in-review"]);
const EXCLUDED_LABELS = new Set([
  "needs-human",
  "workflow:decomposed",
  "workflow:merged",
  "workflow:invalid",
  "workflow:awaiting-merge",
  "blocked-on-human-merge",
  "workflow:engine-error",
  "epic",
]);
const FILE_EXTENSION = /\.(?:py|tsx?|jsx?|sql|json|ya?ml|mjs|js|sh|md)$/i;
const DOMAIN_RULES = [
  ["BILLING", /credit|billing|pricing|stripe|charge|refund/i],
  ["AUTH", /auth|session|jwt|login|permission|oauth/i],
  ["WORKER", /worker|queue|job|task|background|consumer/i],
  ["DATABASE", /migration|\.sql\b|database|postgres|alembic/i],
  ["FRONTEND", /component|page|layout|dashboard|ui|ux|frontend|web\/src/i],
  ["INFRA", /docker|deploy|traefik|nginx|ci|cd|infra|github\.action/i],
  ["AI", /llm|extract|schema|format|embedding|model/i],
];

function labelsOf(issue) {
  return (issue?.labels || [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

function normalizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function priorityWeight(labels) {
  if (labels.some((label) => label === "priority:P0" || label === "P0")) return 4;
  if (labels.some((label) => label === "priority:P1" || label === "P1")) return 3;
  if (labels.some((label) => label === "priority:P2" || label === "P2")) return 2;
  if (labels.some((label) => label === "priority:P3" || label === "P3")) return 1;
  return 1.5;
}

function isInvestigation(issue) {
  const title = String(issue?.title || "");
  const body = String(issue?.body || "");
  return /investigate|audit|research|evaluate|assess|deep dive/i.test(title) ||
    (/(- \[ \]|\* \[ \])/.test(body) && !/affected files|acceptance criteria/i.test(body)) ||
    /deliverable:\s*execution plan|create issues/i.test(body);
}

function scopedSection(body) {
  const source = String(body || "");
  const heading = /^(?:##|###)\s+(Affected Files|Deliverables|Files to change)\s*$/im;
  const match = heading.exec(source);
  if (!match) return "";
  const start = match.index + match[0].length;
  const rest = source.slice(start);
  const end = rest.search(/^#{1,6}\s+/m);
  return end < 0 ? rest : rest.slice(0, end);
}

export function affectedFiles(body) {
  const section = scopedSection(body);
  if (!section) return [];
  return [...section.matchAll(/`([^`\r\n]+)`/g)]
    .map((match) => match[1].trim())
    .filter((file) => FILE_EXTENSION.test(file))
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();
}

export function domainsFor(issue) {
  const text = [issue?.title, issue?.body, ...labelsOf(issue)].join(" ");
  const domains = DOMAIN_RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return domains.length ? domains : ["NONE"];
}

export function explicitDependencies(body) {
  const dependencies = new Set();
  const source = String(body || "");
  const pattern = /(?:depends on|blocked by|after)\s+#?(\d+)\b/gi;
  for (const match of source.matchAll(pattern)) dependencies.add(Number(match[1]));
  return [...dependencies].sort((a, b) => a - b);
}

function controlFlags(input) {
  const source = String(input || "");
  const includeInFlight = /(?:^|\s)(?:--include-in-flight|--recover-in-flight)(?:\s|$)/i.test(source);
  const deepPlan = /(?:^|\s)--deep-plan(?:\s|$)/i.test(source);
  const includeBacklog = /(?:^|\s)--include-backlog(?:\s|$)/i.test(source);
  const confirmed = /(?:^|\s)(?:--auto|--confirm)(?:\s|$)/i.test(source);
  const cleaned = source
    .replace(/(?:^|\s)(?:--include-in-flight|--recover-in-flight|--deep-plan|--include-backlog)(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)(?:--auto|--confirm)(?=\s|$)/gi, " ")
    .replace(/(?:^|\s)--max-concurrent(?:=|\s+)[1-9]\d*(?=\s|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const maxMatch = source.match(/(?:^|\s)--max-concurrent(?:=|\s+)([1-9]\d*)(?=\s|$)/i);
  return {
    input: cleaned,
    includeInFlight,
    deepPlan,
    includeBacklog,
    confirmed,
    maxConcurrent: maxMatch ? Number(maxMatch[1]) : undefined,
  };
}

function tokenizeSearchQuery(query) {
  const tokens = [];
  let token = "";
  let quote = false;
  for (const character of String(query || "")) {
    if (character === '"') {
      quote = !quote;
      continue;
    }
    if (/\s/.test(character) && !quote) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (quote) return { tokens: [], reason: "the GitHub issue-search q parameter contains an unterminated quote" };
  if (token) tokens.push(token);
  return { tokens, reason: "" };
}

function configuredRepoParts(repo) {
  const match = String(repo || "").trim().match(/^([^/]+)\/([^/]+)$/);
  return match ? match.slice(1).map((part) => part.toLowerCase()) : [];
}

const SUPPORTED_SORTS = new Set([
  "created",
  "updated",
  "comments",
  "reactions",
  "interactions",
  "author",
  "committer",
]);

function isSupportedSort(value) {
  const match = String(value || "").toLowerCase().match(/^([a-z]+)(?:-(asc|desc))?$/);
  return Boolean(match && SUPPORTED_SORTS.has(match[1]));
}

/**
 * Parse a copied GitHub issue-search URL without treating it as a slug.
 * Only predicates that can be evaluated against the single open-issue
 * snapshot used by this compact preflight are accepted.
 */
export function parseIssueSearchUrl(input, repo) {
  const source = String(input || "").trim();
  let url;
  try {
    url = new URL(source);
  } catch {
    return { supported: false, reason: "malformed GitHub issue-search URL" };
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) {
    return { supported: false, reason: "GitHub issue-search URL must use the canonical https://github.com host" };
  }

  let pathParts;
  try {
    pathParts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return { supported: false, reason: "GitHub issue-search URL contains malformed path encoding" };
  }
  if (pathParts.length !== 3 || pathParts[2].toLowerCase() !== "issues") {
    return { supported: false, reason: "GitHub issue-search URL must target /owner/repository/issues" };
  }

  const configured = configuredRepoParts(repo);
  if (configured.length !== 2 || pathParts[0].toLowerCase() !== configured[0] || pathParts[1].toLowerCase() !== configured[1]) {
    return {
      supported: false,
      reason: `GitHub issue-search URL repository ${pathParts[0]}/${pathParts[1]} does not match configured repository ${repo || "(missing)"}`,
    };
  }

  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((key) => key !== "q") || queryKeys.filter((key) => key === "q").length !== 1) {
    return { supported: false, reason: "GitHub issue-search URL must contain exactly one q parameter" };
  }
  const query = url.searchParams.get("q")?.trim() || "";
  if (!query) return { supported: false, reason: "GitHub issue-search URL has an empty q parameter" };

  const tokenized = tokenizeSearchQuery(query);
  if (tokenized.reason) return { supported: false, reason: tokenized.reason };

  const labels = [];
  let milestone;
  let noMilestone = false;
  for (const token of tokenized.tokens) {
    const separator = token.indexOf(":");
    const operator = separator < 0 ? token.toLowerCase() : token.slice(0, separator).toLowerCase();
    const value = separator < 0 ? "" : token.slice(separator + 1);
    if (operator === "is" && value.toLowerCase() === "issue") continue;
    if (operator === "state" && value.toLowerCase() === "open") continue;
    if (operator === "state") {
      return { supported: false, reason: `unsupported GitHub issue-search predicate: ${token} (the compact snapshot contains open issues only)` };
    }
    if (operator === "sort" && isSupportedSort(value)) continue;
    if (operator === "order" && /^(asc|desc)$/i.test(value)) continue;
    if (operator === "no" && value.toLowerCase() === "milestone") {
      if (milestone || noMilestone) return { supported: false, reason: "GitHub issue-search URL contains conflicting milestone predicates" };
      noMilestone = true;
      continue;
    }
    if (operator === "milestone" && value) {
      if (milestone || noMilestone) return { supported: false, reason: "GitHub issue-search URL contains conflicting milestone predicates" };
      milestone = value;
      continue;
    }
    if (operator === "label" && value) {
      labels.push(value);
      continue;
    }
    if (operator === "is" && value.toLowerCase() === "pr") {
      return { supported: false, reason: "unsupported GitHub issue-search predicate: is:pr (only issues are supported)" };
    }
    return { supported: false, reason: `unsupported GitHub issue-search predicate: ${token}` };
  }

  if (!noMilestone && !milestone && !labels.length) {
    return { supported: false, reason: "GitHub issue-search URL contains no supported issue predicate" };
  }

  return {
    supported: true,
    pattern: noMilestone ? "no:milestone" : milestone ? "milestone" : labels.length ? "label" : "github-issue-search-url",
    noMilestone,
    milestone,
    labels,
  };
}

function resolveQuery(input, issues, { includeInFlight, repo }) {
  const trimmed = String(input || "").trim();
  const classified = classifyInputPattern(trimmed);
  const lower = trimmed.toLowerCase();
  let pattern = classified.pattern;
  let selected = [...issues];
  const deferred = [];
  let supported = true;
  let reason = "";

  if (!trimmed) {
    supported = false;
    reason = "empty input has no safe issue-set predicate";
  } else if (/^no:milestone$|^no-milestone$/i.test(trimmed)) {
    pattern = "no-milestone";
    selected = selected.filter((issue) => !issue.milestone);
  } else if (classified.pattern === "github-issue-search-url") {
    const parsed = parseIssueSearchUrl(trimmed, repo);
    if (!parsed.supported) {
      supported = false;
      reason = parsed.reason;
    } else {
      pattern = parsed.pattern;
      if (parsed.noMilestone) selected = selected.filter((issue) => !issue.milestone);
      if (parsed.milestone) selected = selected.filter((issue) => normalizeSlug(issue.milestone?.title) === normalizeSlug(parsed.milestone));
      if (parsed.labels?.length) {
        selected = selected.filter((issue) => parsed.labels.every((wanted) =>
          labelsOf(issue).some((label) => normalizeSlug(label) === normalizeSlug(wanted)),
        ));
      }
    }
  } else if (classified.kind === "literal") {
    const requested = new Set();
    for (const token of trimmed.split(/\s+/)) {
      const match = token.match(/^(?:[a-zA-Z0-9_-]+:)?#?(\d+)$/);
      if (!match || token.includes(":")) {
        supported = false;
        reason = "satellite-prefixed literal issues require the full multi-repo resolver";
        break;
      }
      requested.add(Number(match[1]));
    }
    selected = selected.filter((issue) => requested.has(Number(issue.number)));
    const found = new Set(selected.map((issue) => Number(issue.number)));
    for (const number of requested) {
      if (!found.has(number)) selected.push({ number, title: `Issue #${number}`, body: "", labels: [], milestone: null });
    }
  } else if (classified.pattern === "milestone") {
    const requested = normalizeSlug(classified.args.join("-"));
    selected = selected.filter((issue) => normalizeSlug(issue.milestone?.title) === requested);
  } else if (classified.pattern === "next-n") {
    const count = Number(classified.args[0]);
    selected = selected
      .sort((a, b) => priorityWeight(labelsOf(b)) - priorityWeight(labelsOf(a)) || Number(a.number) - Number(b.number))
      .slice(0, Number.isFinite(count) && count > 0 ? count : 0);
  } else if (classified.pattern === "fast-lane") {
    selected = selected.filter((issue) => {
      const labels = labelsOf(issue);
      return !issue.milestone && (labels.includes("bug") || labels.includes("fix") || /^fix[:(]/i.test(issue.title || ""));
    });
  } else if (classified.pattern === "priority") {
    const requested = lower.split(":").at(-1);
    selected = selected.filter((issue) => labelsOf(issue).some((label) => label.toLowerCase() === `priority:${requested}` || label.toLowerCase() === requested));
  } else if (classified.pattern === "bare-slug") {
    const requested = normalizeSlug(trimmed);
    selected = selected.filter((issue) =>
      normalizeSlug(issue.milestone?.title) === requested || labelsOf(issue).some((label) => normalizeSlug(label) === requested),
    );
  } else {
    supported = false;
    reason = `input pattern "${classified.pattern}" needs the full multi-phase resolver`;
  }

  if (!includeInFlight) {
    for (const issue of selected) {
      if (labelsOf(issue).some((label) => IN_FLIGHT_LABELS.has(label))) {
        deferred.push({ number: Number(issue.number), reason: "in-flight" });
      }
    }
    selected = selected.filter((issue) => !labelsOf(issue).some((label) => IN_FLIGHT_LABELS.has(label)));
  }

  return { supported, reason, pattern, classified, selected, deferred };
}

function addEdge(predecessors, predecessor, successor, kind, edges) {
  if (predecessor === successor || !predecessors.has(successor) || !predecessors.has(predecessor)) return;
  predecessors.get(successor).add(predecessor);
  edges.push({ predecessor, successor, kind });
}

export function buildPreflightPlan({ input, repo = "", issues = [], maxConcurrent = 12 } = {}) {
  const flags = controlFlags(input);
  const query = resolveQuery(flags.input, issues, { ...flags, repo });
  if (!query.supported) {
    return {
      version: VERSION,
      supported: false,
      mode: "full-spec-required",
      input: flags.input,
      repo,
      reason: query.reason,
      pattern: query.pattern,
      confirmed: flags.confirmed,
      dispatchNow: [],
      deferred: query.deferred,
      warnings: [query.reason],
    };
  }

  const excluded = [];
  const deferred = [...query.deferred];
  const admitted = [];
  for (const issue of query.selected) {
    const labels = labelsOf(issue);
    const excludedLabel = labels.find((label) => EXCLUDED_LABELS.has(label));
    const isCoordinationIssue = /FORGE:COORD_ISSUE|orchestrate:\s*claims board/i.test(String(issue.body || ""));
    if (excludedLabel || isCoordinationIssue || String(issue.state || "").toUpperCase() === "CLOSED") {
      excluded.push({ number: Number(issue.number), reason: excludedLabel || (isCoordinationIssue ? "orchestration coordination issue" : "closed") });
      continue;
    }
    admitted.push(issue);
  }

  const numbers = new Set(admitted.map((issue) => Number(issue.number)));
  const predecessors = new Map(admitted.map((issue) => [Number(issue.number), new Set()]));
  const edges = [];
  const externalDependencies = new Map();

  for (const issue of admitted) {
    const number = Number(issue.number);
    const dependencies = explicitDependencies(issue.body);
    const external = dependencies.filter((dependency) => !numbers.has(dependency));
    if (external.length) externalDependencies.set(number, external);
    for (const dependency of dependencies) addEdge(predecessors, dependency, number, "explicit", edges);
  }

  const filesByIssue = new Map(admitted.map((issue) => [Number(issue.number), affectedFiles(issue.body)]));
  const owners = new Map();
  for (const [number, files] of filesByIssue) {
    for (const file of files) {
      const existing = owners.get(file) || [];
      for (const other of existing) {
        const predecessor = Math.min(number, other);
        const successor = Math.max(number, other);
        addEdge(predecessors, predecessor, successor, "same-file", edges);
      }
      existing.push(number);
      owners.set(file, existing);
    }
  }

  const databaseIssues = admitted
    .filter((issue) => domainsFor(issue).includes("DATABASE"))
    .map((issue) => Number(issue.number))
    .sort((a, b) => a - b);
  for (let index = 1; index < databaseIssues.length; index++) {
    addEdge(predecessors, databaseIssues[index - 1], databaseIssues[index], "database", edges);
  }

  const records = admitted
    .map((issue) => {
      const number = Number(issue.number);
      const labels = labelsOf(issue);
      return {
        number,
        title: issue.title || `Issue #${number}`,
        labels,
        classification: isInvestigation(issue) ? "INVESTIGATION" : "IMPLEMENTATION",
        domain: domainsFor(issue),
        files: filesByIssue.get(number) || [],
        predecessors: [...(predecessors.get(number) || [])].sort((a, b) => a - b),
        externalDependencies: externalDependencies.get(number) || [],
        priority: priorityWeight(labels),
        inFlight: labels.some((label) => IN_FLIGHT_LABELS.has(label)),
      };
    })
    .sort((a, b) => b.priority - a.priority || a.number - b.number);

  const investigations = records.filter((issue) => issue.classification === "INVESTIGATION");
  const ready = records
    .filter((issue) => issue.predecessors.length === 0 && issue.externalDependencies.length === 0)
    .sort((a, b) => b.priority - a.priority || a.number - b.number)
    .map((issue) => issue.number);
  const effectiveMax = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 12;
  const deepPlan = flags.deepPlan || query.pattern === "cascade" || query.pattern === "repo-scoped";
  const requiresDeepPlan = deepPlan || investigations.length > 0;
  const warnings = [
    "Compact preflight uses explicit dependencies, scoped issue-body files, and the database serialization rule.",
    "The full Phase 3 conflict/history analysis remains available with --deep-plan or when this preflight is unsupported.",
  ];
  if (flags.includeInFlight) warnings.push("In-flight issues were explicitly admitted for recovery.");
  if (deferred.length) warnings.push(`${deferred.length} in-flight issue(s) were deferred; use --include-in-flight for explicit recovery.`);
  if (flags.includeBacklog) warnings.push("Review-finding backlog scope requires the full cascade resolver.");

  return {
    version: VERSION,
    supported: true,
    mode: requiresDeepPlan ? "compact-with-full-spec-followup" : "compact",
    maxConcurrent: effectiveMax,
    input: flags.input,
    repo,
    pattern: query.pattern,
    total: records.length,
    issues: records,
    investigations: investigations.map((issue) => issue.number),
    inFlight: records.filter((issue) => issue.inFlight).map((issue) => issue.number),
    excluded,
    deferred,
    edges,
    ready,
    dispatchNow: requiresDeepPlan || !flags.confirmed ? [] : ready.slice(0, effectiveMax),
    queued: requiresDeepPlan ? ready : ready.slice(effectiveMax),
    confirmed: flags.confirmed,
    requiresConfirmation: !flags.confirmed,
    requiresDeepPlan,
    warnings,
  };
}

function ghJson(cwd, args) {
  const result = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || "gh command failed").trim();
    throw new Error(`GitHub preflight failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    throw new Error("GitHub preflight returned invalid JSON");
  }
}

function forgeConfigPath(cwd) {
  let current = resolve(cwd);
  while (true) {
    const path = join(current, "forge.yaml");
    if (existsSync(path)) return path;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function configuredConcurrency(cwd) {
  const path = forgeConfigPath(cwd);
  if (!path) return 12;
  const source = readFileSync(path, "utf8");
  const match = source.match(/^\s*max_concurrent\s*:\s*([1-9]\d*)\s*$/m);
  return match ? Number(match[1]) : 12;
}

function configuredRepo(cwd) {
  const path = forgeConfigPath(cwd);
  if (!path) return "";
  const source = readFileSync(path, "utf8");
  const owner = source.match(/^\s*owner\s*:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1];
  const name = source.match(/^\s*repo\s*:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1];
  return owner && name ? `${owner}/${name}` : "";
}

function parseCli(argv) {
  const options = { cwd: process.cwd(), repo: "", input: "" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--cwd" || arg === "--repo" || arg === "--args") {
      options[arg.slice(2) === "args" ? "input" : arg.slice(2)] = argv[++index] || "";
    } else if (!options.input) {
      options.input = arg;
    }
  }
  return options;
}

export function runPreflight({ cwd = process.cwd(), repo, input, gh = ghJson } = {}) {
  repo ||= configuredRepo(cwd);
  if (!repo) throw new Error("--repo is required or must be present in forge.yaml");
  const flags = controlFlags(input);
  const issueArgs = [
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,title,body,labels,milestone,state,createdAt,updatedAt",
  ];
  let issues = gh(cwd, issueArgs);
  if (!Array.isArray(issues)) issues = [];

  if (classifyInputPattern(flags.input).kind === "literal") {
    const requested = [...flags.input.matchAll(/(?:^|\s)(?:[a-zA-Z0-9_-]+:)?#?(\d+)/g)].map((match) => Number(match[1]));
    const found = new Set(issues.map((issue) => Number(issue.number)));
    for (const number of requested.filter((item) => !found.has(item))) {
      issues.push(gh(cwd, ["issue", "view", String(number), "-R", repo, "--json", "number,title,body,labels,milestone,state,createdAt,updatedAt"]));
    }
  }

  return buildPreflightPlan({
    input,
    repo,
    issues,
    maxConcurrent: flags.maxConcurrent || configuredConcurrency(cwd),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseCli(process.argv.slice(2));
    const plan = runPreflight(options);
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
