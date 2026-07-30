import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function splitArguments(input) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const char of String(input || "")) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += char;
  }
  if (escaped) token += "\\";
  if (quote) throw codedError("OPENCODE_INVALID_ARGUMENTS", "Unterminated quote in ForgeDock arguments.");
  if (token) tokens.push(token);
  return tokens;
}

function commandTokens(input) {
  const tokens = splitArguments(input);
  // `opencode run --command forge/work-on "42 --dry-run"` currently forwards
  // the command payload with one literal outer quote layer. Interactive slash
  // commands do not. Normalize exactly that one-token-with-whitespace shape so
  // both entry modes reach the same parser without accepting arbitrary nested
  // shell syntax.
  return tokens.length === 1 && /\s/.test(tokens[0]) ? splitArguments(tokens[0]) : tokens;
}

function consumeFlags(tokens, definitions) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = token.split(/=(.*)/s, 2);
    const definition = definitions[name];
    if (!definition) throw codedError("OPENCODE_INVALID_ARGUMENTS", `Unknown ForgeDock flag: ${name}`);
    if (definition === "boolean") {
      if (inline !== undefined && inline !== "") {
        throw codedError("OPENCODE_INVALID_ARGUMENTS", `${name} does not take a value.`);
      }
      flags[name.slice(2)] = true;
      continue;
    }
    const value = inline !== undefined ? inline : tokens[++index];
    if (!value || value.startsWith("--")) {
      throw codedError("OPENCODE_INVALID_ARGUMENTS", `${name} requires a value.`);
    }
    flags[name.slice(2)] = value;
  }
  return { positionals, flags };
}

export function parseWorkOnArguments(input) {
  const { positionals, flags } = consumeFlags(commandTokens(input), {
    "--lane": "value",
    "--repo": "value",
    "--model": "value",
    "--variant": "value",
    "--max-attempts": "value",
    "--dry-run": "boolean",
    "--keep-worktree": "boolean",
    "--under-orchestration": "boolean",
  });
  if (positionals.length !== 1) {
    throw codedError(
      "OPENCODE_INVALID_ARGUMENTS",
      "Usage: /forge/work-on <issue|prefix:issue> [--lane branch] [--repo owner/repo] [--model provider/model] [--dry-run]",
    );
  }
  const match = positionals[0].match(/^(?:([A-Za-z0-9_-]+):)?#?(\d+)$/);
  if (!match || Number(match[2]) < 1) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", `Invalid issue reference: ${positionals[0]}`);
  }
  const maxAttempts = flags["max-attempts"] === undefined ? undefined : Number(flags["max-attempts"]);
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", "--max-attempts must be an integer from 1 through 10.");
  }
  if (flags.variant && !flags.model) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", "--variant requires --model.");
  }
  if (flags.model) parseModel(flags.model, flags.variant);
  return {
    issue: Number(match[2]),
    prefix: match[1] || "",
    lane: flags.lane || "",
    repo: flags.repo || "",
    model: flags.model || "",
    variant: flags.variant || "",
    maxAttempts,
    dryRun: flags["dry-run"] === true,
    keepWorktree: flags["keep-worktree"] === true,
    underOrchestration: flags["under-orchestration"] === true,
  };
}

export function parseOrchestrateArguments(input) {
  const { positionals, flags } = consumeFlags(commandTokens(input), {
    "--lane": "value",
    "--repo": "value",
    "--model": "value",
    "--variant": "value",
    "--max-concurrent": "value",
    "--max-attempts": "value",
    "--resume": "value",
    "--auto": "boolean",
    "--confirm": "boolean",
    "--dry-run": "boolean",
    "--keep-worktrees": "boolean",
    "--include-in-flight": "boolean",
    "--recover-in-flight": "boolean",
    "--include-backlog": "boolean",
    "--deep-plan": "boolean",
  });
  const maxConcurrent = flags["max-concurrent"] === undefined ? undefined : Number(flags["max-concurrent"]);
  if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64)) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", "--max-concurrent must be an integer from 1 through 64.");
  }
  const maxAttempts = flags["max-attempts"] === undefined ? undefined : Number(flags["max-attempts"]);
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", "--max-attempts must be an integer from 1 through 10.");
  }
  if (flags.variant && !flags.model) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", "--variant requires --model.");
  }
  if (flags.model) parseModel(flags.model, flags.variant);
  if (flags.auto && flags.confirm) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", "Use either --auto or --confirm, not both.");
  }
  const planningControls = [];
  if (flags["include-in-flight"]) planningControls.push("--include-in-flight");
  if (flags["recover-in-flight"]) planningControls.push("--recover-in-flight");
  if (flags["include-backlog"]) planningControls.push("--include-backlog");
  if (flags["deep-plan"]) planningControls.push("--deep-plan");
  const preflightControls = [...planningControls];
  if (flags.auto) preflightControls.push("--auto");
  if (maxConcurrent) preflightControls.push("--max-concurrent", String(maxConcurrent));
  const resumeOverrides = [];
  if (positionals.length) resumeOverrides.push("issue query");
  if (planningControls.length) resumeOverrides.push(...planningControls);
  if (flags.lane !== undefined) resumeOverrides.push("--lane");
  if (flags.model !== undefined) resumeOverrides.push("--model");
  if (flags.variant !== undefined) resumeOverrides.push("--variant");
  if (flags["max-attempts"] !== undefined) resumeOverrides.push("--max-attempts");
  if (flags["max-concurrent"] !== undefined) resumeOverrides.push("--max-concurrent");
  if (flags["keep-worktrees"]) resumeOverrides.push("--keep-worktrees");
  if (flags.resume && resumeOverrides.length) {
    throw codedError(
      "OPENCODE_RESUME_OVERRIDE",
      `--resume executes its persisted plan; remove execution-changing override(s): ${resumeOverrides.join(", ")}.`,
    );
  }
  return {
    query: positionals.join(" ").trim(),
    preflightInput: [...positionals, ...preflightControls].join(" ").trim(),
    lane: flags.lane || "",
    repo: flags.repo || "",
    model: flags.model || "",
    variant: flags.variant || "",
    maxConcurrent,
    maxAttempts,
    resume: flags.resume || "",
    auto: flags.auto === true,
    confirm: flags.confirm === true,
    confirmed: flags.auto === true || flags.confirm === true,
    dryRun: flags["dry-run"] === true,
    keepWorktrees: flags["keep-worktrees"] === true,
  };
}

export function findForgeConfig(start) {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, "forge.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function section(source, name) {
  const match = new RegExp(`^${name}:\\s*$([\\s\\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:\\s*$|(?![\\s\\S]))`, "m").exec(source);
  return match?.[1] || "";
}

function value(source, key) {
  const match = new RegExp(`^\\s+${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))\\s*$`, "m").exec(source);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function parseSatellites(source) {
  const repos = section(source, "repos");
  const satellitesMatch = /^\s{2}satellites:\s*$([\s\S]*)$/m.exec(repos);
  if (!satellitesMatch) return [];
  const entries = [];
  let current = null;
  for (const line of satellitesMatch[1].split(/\r?\n/)) {
    if (/^\s{2}\S/.test(line)) break;
    const start = line.match(/^\s{4}-\s+prefix:\s*["']?([^\s"'#]+)["']?\s*$/);
    if (start) {
      current = { prefix: start[1] };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s{6}(repo|staging_branch|local_path):\s*["']?(.+?)["']?\s*$/);
    if (field) current[field[1]] = field[2].replace(/^['"]|['"]$/g, "");
  }
  return entries;
}

export function readForgeConfig(start) {
  const path = findForgeConfig(start);
  if (!path) throw codedError("OPENCODE_CONFIG_MISSING", `forge.yaml was not found from ${resolve(start)}.`);
  const source = readFileSync(path, "utf8");
  const project = section(source, "project");
  const paths = section(source, "paths");
  const branches = section(source, "branches");
  const orchestration = section(source, "orchestration");
  const owner = value(project, "owner");
  const repoName = value(project, "repo");
  const config = {
    path,
    root: value(paths, "root") || dirname(path),
    repo: owner && repoName ? `${owner}/${repoName}` : "",
    defaultBranch: value(branches, "default") || "main",
    stagingBranch: value(branches, "staging") || "staging",
    featurePattern: value(branches, "feature_pattern") || "milestone/{slug}",
    maxConcurrent: Number(value(orchestration, "max_concurrent")) || 12,
    satellites: parseSatellites(source),
  };
  if (!config.repo) throw codedError("OPENCODE_CONFIG_INVALID", `${path} is missing project.owner or project.repo.`);
  return config;
}

export function resolveRepository({ cwd, prefix = "", repo = "" }) {
  const config = readForgeConfig(cwd);
  if (!prefix) return { config, cwd: resolve(cwd), repo: repo || config.repo, stagingBranch: config.stagingBranch };
  const satellite = config.satellites.find((item) => item.prefix === prefix);
  if (!satellite) throw codedError("OPENCODE_CONFIG_INVALID", `Unknown repository prefix: ${prefix}`);
  if (!satellite.repo || !satellite.local_path || !satellite.staging_branch) {
    throw codedError("OPENCODE_CONFIG_INVALID", `Satellite ${prefix} requires repo, local_path, and staging_branch.`);
  }
  if (repo && repo !== satellite.repo) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", `--repo ${repo} conflicts with prefix ${prefix} (${satellite.repo}).`);
  }
  return {
    config,
    cwd: resolve(satellite.local_path),
    repo: satellite.repo,
    stagingBranch: satellite.staging_branch,
  };
}

export function parseModel(model, variant = "") {
  const slash = String(model || "").indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw codedError("OPENCODE_INVALID_ARGUMENTS", `OpenCode model must use provider/model format: ${model}`);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1), variant: variant || undefined };
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";
}

export function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
