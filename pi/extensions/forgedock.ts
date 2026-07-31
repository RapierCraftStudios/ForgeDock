import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ForgeCommand = { id: string; name: string; relativePath: string; absolutePath: string; description: string };
type PlanIssue = { number: number; title: string; predecessors: number[]; domain: string[]; files: string[]; priority: number; inFlight?: boolean };
type PreflightPlan = {
	supported: boolean; reason?: string; mode?: string; pattern?: string; total?: number; issues?: PlanIssue[];
	edges?: Array<{ predecessor: number; successor: number; kind: string }>; ready?: number[]; dispatchNow?: number[];
	deferred?: Array<{ number: number; reason: string }>; excluded?: Array<{ number: number; reason: string }>;
	investigations?: number[]; warnings?: string[]; requiresDeepPlan?: boolean;
};

const INTERNAL_COMMANDS = new Set(["review-pr-agents.md"]);
const TERMINAL_LABELS = new Set(["workflow:merged", "workflow:invalid", "workflow:awaiting-merge", "needs-human"]);

function extensionDir(): string {
	try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
}

function findForgeRoot(start: string): string | undefined {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, "commands")) && existsSync(join(current, "AGENTS.md"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function walkMarkdown(dir: string, root = dir): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkMarkdown(full, root));
		else if (entry.isFile() && entry.name.endsWith(".md")) files.push(relative(root, full).replace(/\\/g, "/"));
	}
	return files.sort();
}

function commandName(path: string): string {
	return `forge-${path.replace(/\.md$/, "").replace(/[^a-zA-Z0-9]+/g, "-")}`.toLowerCase().replace(/^-+|-+$/g, "");
}
function commandId(path: string): string { return path.replace(/\.md$/, "").replace(/\//g, ":"); }
function description(file: string, fallback: string): string {
	try { return readFileSync(file, "utf8").match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || fallback; }
	catch { return fallback; }
}
function discoverCommands(root: string): ForgeCommand[] {
	const dir = join(root, "commands");
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	return walkMarkdown(dir).filter((path) => !INTERNAL_COMMANDS.has(path)).map((path) => ({
		id: commandId(path), name: commandName(path), relativePath: path, absolutePath: join(dir, path),
		description: description(join(dir, path), `Run ForgeDock workflow ${commandId(path)}`),
	}));
}

function stopProcessTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
	} else if (!child.killed) {
		child.kill();
	}
}

function runProcess(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, FORGE_RUNTIME: "pi" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = ""; let stderr = "";
		const abort = () => stopProcessTree(child);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.once("error", reject);
		child.once("close", (code) => { signal?.removeEventListener("abort", abort); resolvePromise({ code, stdout, stderr }); });
	});
}

function piExecutable(): string { return process.platform === "win32" ? "pi.cmd" : "pi"; }
function ghJson(root: string, args: string[]): unknown {
	const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(String(result.stderr || "gh command failed").trim());
	return JSON.parse(result.stdout || "null");
}
function repoFromConfig(root: string): string {
	const source = readFileSync(join(root, "forge.yaml"), "utf8");
	const owner = source.match(/^\s*owner:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1];
	const repo = source.match(/^\s*repo:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1];
	if (!owner || !repo) throw new Error("forge.yaml does not define project.owner/project.repo");
	return `${owner}/${repo}`;
}

function normalizeInput(input: string): string {
	const url = input.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/?(?:\?(.*))?$/i);
	if (!url?.[1]) return input;
	const query = decodeURIComponent(url[1]).replace(/&/g, " ").replace(/=/g, ":");
	return query.replace(/^q:/i, "").replace(/\bstate:open\b/i, "").replace(/\bis:issue\b/i, "").replace(/\s+/g, " ").trim();
}

function preflight(root: string, input: string): PreflightPlan {
	const result = spawnSync(process.execPath, [join(root, "bin", "orchestrate-preflight.mjs"), "--cwd", root, "--repo", repoFromConfig(root), "--args", normalizeInput(input)], {
		cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(String(result.stderr || "preflight failed").trim());
	return JSON.parse(result.stdout) as PreflightPlan;
}

function terminalIssue(root: string, repo: string, number: number): boolean {
	try {
		const data = ghJson(root, ["issue", "view", String(number), "-R", repo, "--json", "state,labels,comments"]) as { state: string; labels: Array<{ name: string }>; comments: Array<{ body: string }> };
		const labels = new Set((data.labels || []).map((label) => label.name));
		if (data.state === "CLOSED") return true;
		return [...TERMINAL_LABELS].some((label) => labels.has(label));
	} catch { return false; }
}

function renderPlan(plan: PreflightPlan): string {
	const rows = (plan.issues || []).map((issue) => {
		const deps = issue.predecessors.length ? issue.predecessors.map((n) => `#${n}`).join(", ") : "—";
		const files = issue.files.length ? issue.files.join(", ") : "—";
		const safeTitle = issue.title.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
		return `| #${issue.number} | ${safeTitle} | ${deps} | ${issue.domain.join(", ")} | ${files} | ${issue.inFlight ? "resume" : "ready/queued"} |`;
	}).join("\n");
	return [
		`## ForgeDock DAG (${plan.total ?? 0} issues)`,
		`Mode: ${plan.mode || "full"} · Pattern: ${plan.pattern || "custom"}`,
		"",
		"| Issue | Title | Predecessors | Domain | Declared files | Action |",
		"|---|---|---|---|---|---|", rows || "| — | No eligible issues | — | — | — | — |",
		"", `Initial ready queue: ${(plan.ready || []).map((n) => `#${n}`).join(", ") || "none"}`,
		`Edges: ${(plan.edges || []).map((edge) => `#${edge.predecessor} → #${edge.successor} (${edge.kind})`).join(", ") || "none"}`,
		...(plan.deferred || []).length ? [`Deferred: ${(plan.deferred || []).map((item) => `#${item.number} (${item.reason})`).join(", ")}`] : [],
		...(plan.warnings || []).map((warning) => `Warning: ${warning}`),
	].join("\n");
}

async function runWorker(root: string, repo: string, number: number, signal?: AbortSignal): Promise<{ number: number; code: number | null; output: string; stoppedAtTerminal: boolean }> {
	const prompt = `You are ForgeDock Pi worker for issue #${number}. Read ${join(root, "AGENTS.md")}, ${join(root, "docs", "PI.md")}, ${join(root, "commands", "work-on.md")} and all referenced phase files. Execute the complete /work-on pipeline for issue #${number}; resume from GitHub state rather than restarting completed phases. Preserve annotations, labels, branches, review, merge, and cleanup. You are a worker inside an orchestrator: do not work on any other issue, do not summarize early, and stop immediately once the issue is closed or has a terminal workflow label.`;
	const child = spawn(piExecutable(), ["--no-session", "--approve", "--name", `forge-work-on-${number}`, "-p", prompt], {
		cwd: root, env: { ...process.env, FORGE_RUNTIME: "pi", FORGE_PI_WORKER: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
	});
	let output = "";
	child.stdout?.on("data", (chunk) => { output += String(chunk); });
	child.stderr?.on("data", (chunk) => { output += String(chunk); });
	let stoppedAtTerminal = false;
	let polling = true;
	const poll = async () => {
		while (polling) {
			if (terminalIssue(root, repo, number)) {
				stoppedAtTerminal = true;
				stopProcessTree(child);
				return;
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
		}
	};
	const abort = () => { polling = false; stopProcessTree(child); };
	signal?.addEventListener("abort", abort, { once: true });
	const result = await Promise.race([
		new Promise<{ code: number | null }>((resolvePromise, reject) => { child.once("error", reject); child.once("close", (code) => resolvePromise({ code })); }),
		poll().then(() => ({ code: 0 })),
	]);
	polling = false;
	signal?.removeEventListener("abort", abort);
	if (!stoppedAtTerminal) stoppedAtTerminal = terminalIssue(root, repo, number);
	return { number, code: result.code, output, stoppedAtTerminal };
}

async function orchestrate(root: string, input: string, ctx: ExtensionContext, auto = false): Promise<string> {
	let plan = preflight(root, input);
	let planText = renderPlan(plan);
	if (!plan.supported) return `${planText}\n\nFull ForgeDock phase execution is required: ${plan.reason || "unsupported input"}. No agents were dispatched.`;
	if (plan.requiresDeepPlan && (plan.investigations?.length || 0) > 0) {
		if (!auto && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("ForgeDock investigation wave", `${planText}\n\nInvestigation issues must run first. Dispatch Wave 0 now?`);
			if (!confirmed) return `${planText}\n\nDispatch cancelled.`;
		}
		const repo = repoFromConfig(root);
		await Promise.all(plan.investigations!.map((number) => runWorker(root, repo, number, ctx.signal)));
		plan = preflight(root, input);
		planText = renderPlan(plan);
	}
	if (plan.requiresDeepPlan) return `${renderPlan(plan)}\n\nThis batch requires the full ForgeDock phase planner (deep conflict/history analysis). No implementation agents were dispatched by the compact Pi controller; use the shared /orchestrate workflow for this batch.`;
	if (!plan.issues?.length) return `${renderPlan(plan)}\n\nNothing to dispatch.`;
	if (!auto && ctx.hasUI) {
		const confirmed = await ctx.ui.confirm("ForgeDock execution plan", `${planText}\n\nDispatch ready issues and resume admitted inflight issues?`);
		if (!confirmed) return `${planText}\n\nDispatch cancelled.`;
	}
	const repo = repoFromConfig(root);
	const issueMap = new Map((plan.issues || []).map((issue) => [issue.number, issue]));
	const completed = new Set<number>();
	const pending = new Set((plan.issues || []).map((issue) => issue.number));
	const results: Array<{ number: number; code: number | null; stoppedAtTerminal: boolean }> = [];
	const maxConcurrent = Math.max(1, Math.min(35, Number(input.match(/--max-concurrent(?:=|\s+)(\d+)/)?.[1] || 12)));

	while (pending.size) {
		const ready = [...pending].filter((number) => (issueMap.get(number)?.predecessors || []).every((dependency) => completed.has(dependency)));
		if (!ready.length) return `${planText}\n\nBlocked: no ready issues remain. Check dependency edges or GitHub state.`;
		const batch = ready.slice(0, maxConcurrent);
		ctx.ui.setStatus("forgedock", `ForgeDock: running ${batch.map((n) => `#${n}`).join(", ")}`);
		const batchResults = await Promise.all(batch.map((number) => runWorker(root, repo, number, ctx.signal)));
		for (const result of batchResults) {
			if (!result.stoppedAtTerminal) {
				return `${planText}\n\nWorker #${result.number} exited before reaching a terminal GitHub state (exit ${result.code ?? "unknown"}). Dependents were not dispatched.`;
			}
			pending.delete(result.number); completed.add(result.number); results.push(result);
		}
	}
	ctx.ui.setStatus("forgedock", "ForgeDock: batch complete");
	return `${planText}\n\n## Results\n${results.map((result) => `- #${result.number}: ${result.stoppedAtTerminal ? "terminal state detected; worker stopped" : `worker exited (${result.code})`}`).join("\n")}`;
}

function sendPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

export default function forgedockPiExtension(pi: ExtensionAPI) {
	const root = process.env.FORGE_HOME || findForgeRoot(extensionDir()) || findForgeRoot(process.cwd()) || process.cwd();
	const commands = discoverCommands(root);
	const byName = new Map(commands.map((command) => [command.name, command]));

	const orchestrateHandler = async (args: string, ctx: ExtensionCommandContext) => {
		try { ctx.ui.notify("Running deterministic ForgeDock preflight…", "info"); ctx.ui.setWidget("forgedock-plan", ["ForgeDock is resolving issues and building the DAG…"]); const result = await orchestrate(root, args, ctx, /(?:^|\s)--(?:auto|confirm)(?:\s|$)/.test(args)); ctx.ui.setWidget("forgedock-plan", undefined); ctx.ui.notify("ForgeDock orchestration finished", "info"); pi.sendMessage({ customType: "forgedock-orchestration", content: result, display: true, details: { terminalAware: true } }); }
		catch (error) { ctx.ui.setWidget("forgedock-plan", undefined); ctx.ui.notify(`ForgeDock orchestration failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
	};

	pi.registerCommand("forge-orchestrate", { description: "Build and execute a deterministic ForgeDock DAG", handler: orchestrateHandler });
	pi.registerTool({
		name: "forge_orchestrate", label: "Forge Orchestrate",
		description: "Resolve ForgeDock issues, present the dependency DAG, ask for confirmation, then run isolated Pi workers in parallel. Resumes in-flight issues only when requested.",
		parameters: Type.Object({ input: Type.String({ description: "Issue query, milestone, issue numbers, or GitHub issue-search URL." }), includeInFlight: Type.Optional(Type.Boolean({ description: "Resume workflow:building and workflow:in-review issues." })), auto: Type.Optional(Type.Boolean({ description: "Skip the interactive confirmation checkpoint." })) }),
		async execute(_id, params, signal, _update, ctx) {
			const input = `${params.input}${params.includeInFlight ? " --include-in-flight" : ""}`;
			const result = await orchestrate(root, input, ctx, Boolean(params.auto));
			return { content: [{ type: "text", text: result }], details: { input, terminalAware: true } };
		},
	});

	pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("forgedock", commands.length ? `ForgeDock: ${commands.length} workflows` : "ForgeDock: unavailable"));
	pi.registerCommand("forge", { description: "Route work into a ForgeDock workflow", handler: async (args, ctx) => {
		const [first, ...rest] = args.trim().split(/\s+/); const key = first?.replace(/^\//, "").replace(/^forge[-:]?/, "").replace(/-/g, ":");
		if (key === "orchestrate") { await orchestrateHandler(rest.join(" "), ctx); return; }
		const command = commands.find((item) => item.id === key || item.name === first);
		if (command) { sendPrompt(pi, ctx, `Read and execute ${command.absolutePath} for arguments: ${rest.join(" ") || "(none)"}. Follow the shared ForgeDock spec and use forge_subagent for required isolated work.`); return; }
		ctx.ui.notify("Use /forge-orchestrate <query> or /forge-work-on <issue>.", "info");
	}});
	for (const command of commands) if (byName.get(command.name) === command && command.name !== "forge-orchestrate") pi.registerCommand(command.name, { description: command.description, handler: async (args, ctx) => sendPrompt(pi, ctx, `Read and execute ${command.absolutePath} for arguments: ${args || "(none)"}. Follow the shared ForgeDock spec.`) });

	pi.registerTool({ name: "forge_subagent", label: "Forge Subagent", description: "Run an isolated Pi subprocess for ForgeDock review or subtask work.", parameters: Type.Object({ prompt: Type.String(), label: Type.Optional(Type.String()), readOnly: Type.Optional(Type.Boolean()) }), async execute(_id, params, signal, _update, ctx) {
		const result = await runProcess(piExecutable(), ["--no-session", "--approve", "--name", params.label || "forge-subagent", ...(params.readOnly ? ["--tools", "read,grep,find,ls,bash"] : []), "-p", params.prompt], ctx.cwd, signal);
		return { content: [{ type: "text", text: `exit_code=${result.code}\n${result.stdout}\n${result.stderr}` }], details: result, isError: result.code !== 0 };
	}});
}
