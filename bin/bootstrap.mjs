// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `forgedock bootstrap` (#4177, part of #4155): the headless `/bootstrap`.
 *   - Plan mode, `--plan <plan.json> [--dry-run] [--repo] [--config] [--base] [--json] [--cost-per-issue <usd>]`:
 *     scripts/bootstrap-create.mjs validates and previews (dry run, no GitHub access) or creates the backlog. No LLM
 *     call. Re-running the same command resumes from GitHub state: existing spike, milestones, branches, issues and
 *     marker comments are reused, so no local state is needed.
 *   - Idea mode, `<free text | docs path> [--dry-run] [--spike <path>] [--model <id>] [--backend <cli|api|auto>]`:
 *     runs commands/bootstrap.md headlessly through runner.mjs runCommand. `--dry-run` and `--spike` are spec
 *     arguments; `--dry-run` is never the runner's own prompt-preview dryRun.
 * Exit: 0 ok; 1 failed run (or invalid plan); 2 usage; 3 GitHub error (plan mode, re-run to resume).
 */

const USAGE = "usage: forgedock bootstrap <idea | docs path> [--dry-run] [--spike <path>] [--model <id>] [--backend <cli|api|auto>]\n" +
  "       forgedock bootstrap --plan <plan.json> [--dry-run] [--repo OWNER/NAME] [--config forge.yaml] [--base <branch>] [--json] [--cost-per-issue <usd>]\n";

/**
 * @param {string[]} argv  arguments after `bootstrap`
 * @param {{runCommand?: Function, createMain?: Function, commandsDir?: string, cwd?: string, out?: {write}, err?: {write}}} deps
 * @returns {Promise<number>} exit code
 */
export async function runBootstrap(argv = [], deps = {}) {
  const { commandsDir, cwd = process.cwd(), out = process.stdout, err = process.stderr } = deps;
  const needValue = (i) => i + 1 < argv.length && !argv[i + 1].startsWith("--");
  const planIdx = argv.indexOf("--plan");
  if (planIdx !== -1) {
    if (!needValue(planIdx)) { err.write(`forgedock bootstrap: --plan requires a value\n${USAGE}`); return 2; }
    const createMain = deps.createMain ?? (await import("../scripts/bootstrap-create.mjs")).main;
    const rest = [...argv.slice(0, planIdx), ...argv.slice(planIdx + 2)];
    return createMain([argv[planIdx + 1], ...rest], { out, err });
  }

  const args = [];
  let model, backend;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.push(a);
    else if (a === "--spike" || a === "--model" || a === "--backend") {
      if (!needValue(i)) { err.write(`forgedock bootstrap: ${a} requires a value\n${USAGE}`); return 2; }
      const v = argv[++i];
      if (a === "--spike") args.push(a, v);
      else if (a === "--model") model = v;
      else backend = v;
    } else if (a.startsWith("--")) { err.write(`forgedock bootstrap: unknown argument ${a}\n${USAGE}`); return 2; }
    else args.push(a);
  }
  if (!args.some((a, i) => !a.startsWith("--") && args[i - 1] !== "--spike")) { err.write(USAGE); return 2; }
  const runCommand = deps.runCommand ?? (await import("./runner.mjs")).runCommand;
  const result = await runCommand({
    commandsDir, commandName: "bootstrap", args, cwd, dryRun: false,
    ...(model ? { model } : {}), ...(backend ? { backend } : {}),
  });
  return result && (result.status === "max-iterations" || result.status === "incomplete") ? 1 : 0;
}
