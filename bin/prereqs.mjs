/**
 * Shared prerequisite list for setup (journey preflight) and `doctor` (#5302).
 * One definition, so both report the same tools with the same fix commands.
 */
import { existsSync } from "fs";
import { spawnSync } from "child_process";

/** Ids of the prerequisites, in report order. */
export const PREREQ_IDS = ["node", "git", "claude-code", "gh", "yq"];

const GH_URL = "Install gh: https://cli.github.com/";

function installFor(id, platform) {
  const mac = platform === "darwin";
  const win = platform === "win32";
  if (id === "gh") {
    if (mac) return { fix: [GH_URL, "brew install gh"], auto: ["brew", "install", "gh"] };
    if (win) return { fix: [GH_URL, "winget install --id GitHub.cli -e"], auto: ["winget", "install", "--id", "GitHub.cli", "-e"] };
    return { fix: [GH_URL] };
  }
  if (id === "yq") {
    if (mac) return { fix: ["brew install yq"], auto: ["brew", "install", "yq"] };
    if (win) return { fix: ["winget install --id MikeFarah.yq -e"], auto: ["winget", "install", "--id", "MikeFarah.yq", "-e"] };
    return { fix: ["Install yq (mikefarah, not the python one): https://github.com/mikefarah/yq#install"] };
  }
  return null;
}

/**
 * Probe every prerequisite.
 * @param {{ exec: (cmd: string, args: string[]) => string, nodeVersion: string, claudeDir: string, platform?: string }} o
 * @returns {Array<{ id: string, label: string, ok: boolean, blocking: boolean, detail: string, fix?: string[], auto?: string[] }>}
 *   `blocking` is true for a missing tool; an installed-but-unauthenticated gh fails but does not block setup.
 */
export function checkPrereqs({ exec, nodeVersion, claudeDir, platform = process.platform }) {
  const out = [];
  const add = (id, label, ok, detail, extra = {}) => {
    const inst = ok ? null : installFor(id, platform);
    out.push({
      id, label, ok, blocking: !ok && extra.blocking !== false, detail,
      ...(ok ? {} : { fix: extra.fix ?? inst?.fix ?? [] }),
      ...(!ok && inst?.auto && extra.blocking !== false ? { auto: inst.auto } : {}),
    });
  };
  const major = Number(String(nodeVersion).split(".")[0]);
  if (major >= 18) add("node", "Node", true, `v${nodeVersion}`);
  else add("node", "Node", false, `v${nodeVersion} — need ≥18`, { fix: ["Upgrade Node: https://nodejs.org/"] });

  try {
    add("git", "git", true, exec("git", ["--version"]).replace(/^git version\s*/, ""));
  } catch {
    add("git", "git", false, "not found", { fix: ["Install git: https://git-scm.com/downloads"] });
  }

  if (existsSync(claudeDir)) add("claude-code", "Claude Code", true, `${claudeDir} found`);
  else add("claude-code", "Claude Code", false, `${claudeDir} not found`, { fix: ["Install Claude Code: https://claude.com/claude-code"] });

  let ghInstalled = true;
  try {
    exec("gh", ["--version"]);
  } catch {
    ghInstalled = false;
    add("gh", "GitHub CLI", false, "not found");
  }
  if (ghInstalled) {
    try {
      exec("gh", ["auth", "status"]);
      add("gh", "GitHub CLI", true, "authenticated");
    } catch {
      add("gh", "GitHub CLI", false, "not authenticated", { fix: ["Run: gh auth login"], blocking: false });
    }
  }

  try {
    add("yq", "yq", true, exec("yq", ["--version"]));
  } catch {
    add("yq", "yq", false, "not found");
  }
  return out;
}

/** The "Not ready yet" summary for the blocking prerequisites that are missing. */
export function formatNotReady(missing) {
  const n = missing.length;
  const lines = ["", `  Not ready yet: ${n} thing${n === 1 ? "" : "s"} to install`, ""];
  missing.forEach((m, i) => {
    lines.push(`  ${i + 1}. ${m.label} — ${m.detail}`);
    for (const f of m.fix ?? []) lines.push(`       ${f}`);
  });
  lines.push("", "  Re-run `npx forgedock` when done.", "");
  return lines.join("\n");
}

/**
 * Offer to install the installable ones among `items`, asking consent for each.
 * @returns {Promise<string[]>} ids that were installed successfully
 */
export async function offerInstall(items, { confirmFn, run = defaultRun, write = () => {} }) {
  const done = [];
  for (const m of items) {
    if (!m.auto) continue;
    if (!(await confirmFn(`Install ${m.label} now? (${m.auto.join(" ")})`, false))) continue;
    if (run(m.auto) === 0) done.push(m.id);
    else write(`  Could not install ${m.label}; run it yourself: ${m.auto.join(" ")}\n`);
  }
  return done;
}

function defaultRun(argv) {
  return spawnSync(argv[0], argv.slice(1), { stdio: "inherit" }).status ?? 1;
}
