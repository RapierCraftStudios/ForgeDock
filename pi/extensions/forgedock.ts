// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runPiIssue } from "../runtime/engine.mjs";
import {
	decideReviewRunAdmission,
	electReviewRunClaim,
	electReviewRunRecovery,
	formatReviewRecoveryClaim,
	formatReviewRunReceipt,
	isTrustedReviewReceiptAuthor,
	scopedReviewerDomains,
} from "../../bin/engine/review-run.mjs";

type ForgeCommand = { id: string; name: string; relativePath: string; absolutePath: string; description: string };
type PlanIssue = { number: number; title: string; predecessors: number[]; domain: string[]; files: string[]; priority: number; inFlight?: boolean };
type PreflightPlan = {
	supported: boolean; reason?: string; mode?: string; pattern?: string; total?: number; maxConcurrent?: number; issues?: PlanIssue[];
	edges?: Array<{ predecessor: number; successor: number; kind: string }>; ready?: number[]; dispatchNow?: number[];
	deferred?: Array<{ number: number; reason: string }>; excluded?: Array<{ number: number; reason: string }>;
	investigations?: number[]; warnings?: string[]; requiresDeepPlan?: boolean;
};
type IssueResult = { number: number; terminalReason?: string | null; detail?: string; code?: number | null; status?: string };

const INTERNAL_COMMANDS = new Set(["review-pr-agents.md"]);
const SUCCESSFUL_TERMINALS = new Set(["merged", "decomposed"]);

function extensionPath(): string {
	return fileURLToPath(import.meta.url);
}

function extensionDir(): string {
	return dirname(extensionPath());
}

function isForgeRoot(current: string): boolean {
	if (!existsSync(join(current, "commands"))) return false;
	if (existsSync(join(current, "AGENTS.md"))) return true;
	try {
		const packageJson = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
		return packageJson?.name === "forgedock";
	} catch {
		return false;
	}
}

function findForgeRoot(start: string): string | undefined {
	let current = resolve(start);
	while (true) {
		if (isForgeRoot(current)) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function findProjectRoot(start: string): string {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, "forge.yaml")) || existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(start);
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

function runProcess(command: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 600_000): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env: { ...process.env, FORGE_RUNTIME: "pi" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = ""; let stderr = ""; let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
		const abort = () => {
			if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
			else if (!child.killed) child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.once("error", reject);
		child.once("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolvePromise({ code, stdout, stderr, timedOut }); });
	});
}

function piExecutable(): string { return process.platform === "win32" ? "pi.cmd" : "pi"; }
function ghJson(root: string, args: string[]): unknown {
	const result = spawnSync("gh", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(String(result.stderr || "gh command failed").trim());
	return JSON.parse(result.stdout || "null");
}
function repoFromConfig(projectRoot: string): string {
	const source = readFileSync(join(projectRoot, "forge.yaml"), "utf8");
	const owner = source.match(/^\s*owner:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1];
	const repo = source.match(/^\s*repo:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1];
	if (!owner || !repo) throw new Error("forge.yaml does not define project.owner/project.repo");
	return `${owner}/${repo}`;
}
function normalizeSlug(value: string): string {
	return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function normalizeInput(input: string): string {
	const url = input.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/?(?:\?(.*))?$/i);
	if (!url?.[1]) return input;
	const query = decodeURIComponent(url[1]).replace(/&/g, " ").replace(/=/g, ":");
	return query.replace(/^q:/i, "").replace(/\bstate:open\b/i, "").replace(/\bis:issue\b/i, "").replace(/\s+/g, " ").trim();
}

function preflight(forgeHome: string, projectRoot: string, input: string): PreflightPlan {
	const result = spawnSync(process.execPath, [join(forgeHome, "bin", "orchestrate-preflight.mjs"), "--cwd", projectRoot, "--repo", repoFromConfig(projectRoot), "--args", normalizeInput(input)], {
		cwd: projectRoot, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(String(result.stderr || "preflight failed").trim());
	return JSON.parse(result.stdout) as PreflightPlan;
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

function parseIssueNumber(args: string): number | undefined {
	const first = args.trim().split(/\s+/)[0] || "";
	const match = first.match(/^#?(\d+)$/);
	return match ? Number(match[1]) : undefined;
}

function issueLane(projectRoot: string, repo: string, issue: number): string {
	const data = ghJson(projectRoot, ["issue", "view", String(issue), "-R", repo, "--json", "milestone"]) as { milestone?: { title?: string } | null };
	const title = data.milestone?.title;
	return title ? `milestone/${normalizeSlug(title)}` : "staging";
}

async function executeIssue(forgeHome: string, projectRoot: string, args: string, ctx: ExtensionContext): Promise<IssueResult> {
	const issue = parseIssueNumber(args);
	if (!issue) throw new Error("Pi's native ForgeDock engine requires an issue number, for example: /forge-work-on #123");
	const repo = repoFromConfig(projectRoot);
	const lane = issueLane(projectRoot, repo, issue);
	ctx.ui.setStatus("forgedock", `ForgeDock: issue #${issue} (${lane})`);
	try {
		return await runPiIssue({
			issue,
			projectRoot,
			forgeHome,
			extensionPath: extensionPath(),
			repo,
			lane,
			model: ctx.model,
			thinkingLevel: ctx.thinkingLevel,
			signal: ctx.signal,
			onProgress: (event) => ctx.ui.setStatus("forgedock", `ForgeDock #${issue}: ${event.event} ${event.phase}`),
		});
	} finally {
		ctx.ui.setStatus("forgedock", undefined);
	}
}

async function orchestrate(forgeHome: string, projectRoot: string, input: string, ctx: ExtensionContext, auto = false): Promise<string> {
	let plan = preflight(forgeHome, projectRoot, input);
	let planText = renderPlan(plan);
	if (!plan.supported) return `${planText}\n\nFull ForgeDock phase execution is required: ${plan.reason || "unsupported input"}. No agents were dispatched.`;
	if (plan.requiresDeepPlan && (plan.investigations?.length || 0) > 0) {
		if (!auto && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm("ForgeDock investigation wave", `${planText}\n\nInvestigation issues must run first. Dispatch Wave 0 now?`);
			if (!confirmed) return `${planText}\n\nDispatch cancelled.`;
		}
		await Promise.all(plan.investigations!.map((number) => executeIssue(forgeHome, projectRoot, String(number), ctx)));
		plan = preflight(forgeHome, projectRoot, input);
		planText = renderPlan(plan);
	}
	if (plan.requiresDeepPlan) return `${renderPlan(plan)}\n\nThis batch requires the full ForgeDock phase planner (deep conflict/history analysis). No implementation agents were dispatched by the compact Pi controller; use the shared /orchestrate workflow for this batch.`;
	if (!plan.issues?.length) return `${renderPlan(plan)}\n\nNothing to dispatch.`;
	if (!auto && ctx.hasUI) {
		const confirmed = await ctx.ui.confirm("ForgeDock execution plan", `${planText}\n\nDispatch ready issues and resume admitted inflight issues?`);
		if (!confirmed) return `${planText}\n\nDispatch cancelled.`;
	}

	const issueMap = new Map((plan.issues || []).map((issue) => [issue.number, issue]));
	const completed = new Set<number>();
	const blocked = new Set<number>();
	const pending = new Set((plan.issues || []).map((issue) => issue.number));
	const results: Array<IssueResult & { status: string }> = [];
	const maxConcurrent = Math.max(1, Math.min(35, plan.maxConcurrent || 12));

	while (pending.size) {
		for (const number of [...pending]) {
			const predecessors = issueMap.get(number)?.predecessors || [];
			const failedDependency = predecessors.find((dependency) => blocked.has(dependency));
			if (failedDependency !== undefined) {
				pending.delete(number);
				blocked.add(number);
				results.push({ number, status: "blocked", terminalReason: "blocked", detail: `predecessor #${failedDependency} did not complete successfully` });
			}
		}
		const ready = [...pending].filter((number) => (issueMap.get(number)?.predecessors || []).every((dependency) => completed.has(dependency)));
		if (!ready.length) {
			return `${planText}\n\n## Results\n${results.map(formatIssueResult).join("\n")}\n\nBlocked: no ready issues remain. Check dependency edges or GitHub state.`;
		}
		const batch = ready.slice(0, maxConcurrent);
		ctx.ui.setStatus("forgedock", `ForgeDock: running ${batch.map((n) => `#${n}`).join(", ")}`);
		const batchResults = await Promise.all(batch.map(async (number) => {
			try {
				const result = await executeIssue(forgeHome, projectRoot, String(number), ctx);
				return { number, status: SUCCESSFUL_TERMINALS.has(String(result.terminalReason)) ? "complete" : "blocked", ...result };
			} catch (error) {
				return { number, status: "error", terminalReason: "engine-error", detail: error instanceof Error ? error.message : String(error) };
			}
		}));
		for (const result of batchResults) {
			pending.delete(result.number);
			results.push(result);
			if (result.status === "complete") completed.add(result.number);
			else blocked.add(result.number);
		}
	}
	ctx.ui.setStatus("forgedock", "ForgeDock: batch complete");
	return `${planText}\n\n## Results\n${results.map(formatIssueResult).join("\n")}`;
}

function issueResultStatus(result: IssueResult): string {
	return SUCCESSFUL_TERMINALS.has(String(result.terminalReason)) ? "complete" : "blocked";
}

function formatIssueResult(result: IssueResult & { status?: string }): string {
	const state = result.status || issueResultStatus(result);
	const detail = result.terminalReason ? ` (${result.terminalReason})` : result.detail ? ` — ${result.detail}` : "";
	return `- #${result.number}: ${state}${detail}`;
}

function resolveReviewPr(projectRoot: string, args: string): number {
	const match = args.match(/(?:^|\s)#?(\d+)(?:\s|$)/);
	if (match) return Number(match[1]);
	const prs = ghJson(projectRoot, ["pr", "list", "--base", "main", "--head", "staging", "--state", "open", "--json", "number"]) as Array<{ number: number }>;
	if (prs.length !== 1) throw new Error("Review requires a PR number, or exactly one open staging-to-main PR");
	return prs[0].number;
}

function postPrComment(projectRoot: string, repo: string, pr: number, body: string): void {
	const result = spawnSync("gh", ["pr", "comment", String(pr), "-R", repo, "--body", body], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(String(result.stderr || "failed to post PR review comment").trim());
}

function requireReviewerGuidance(forgeHome: string): string {
	const guidancePath = join(forgeHome, "AGENTS.md");
	try {
		if (!statSync(guidancePath).isFile()) throw new Error("not a regular file");
		readFileSync(guidancePath, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`ForgeDock reviewer guidance is unavailable or unreadable at ${guidancePath}: ${detail}. Reinstall ForgeDock so AGENTS.md is published and persisted before retrying.`);
	}
	return guidancePath;
}

function reviewAgentPrompt(guidancePath: string, repo: string, pr: number, domain: string, runId: string, headSha: string): string {
	const persona = domain === "security" ? "security" : domain === "runtime" ? "infra" : domain === "workflow" ? "spec-cli" : "protocols";
	return [
		`You are the isolated ForgeDock ${domain} reviewer for PR #${pr} in ${repo}.`,
		`Read ${guidancePath}, ${join(dirname(guidancePath), "commands", "review-pr.md")}, ${join(dirname(guidancePath), "commands", "review-pr-agents", "protocols.md")}, and ${join(dirname(guidancePath), "commands", "review-pr-agents", `${persona}.md`)} before reviewing.`,
		`Inspect PR #${pr} with gh and review only the ${domain} domain.`,
		"Do not edit files, merge, approve, or run another workflow. Use evidence-based findings only.",
		`Before exiting, persist your complete review to the PR with gh pr comment and include exactly: <!-- FORGE:REVIEW-AGENT:${domain} -->, <!-- FORGE:REVIEW-RUN:${runId} -->, and <!-- FORGE:REVIEW-SHA:${headSha} -->`,
		"If there are findings, include structured <!-- FINDING:... --> markers. If clean, explicitly state PASS. Do not claim completion until the GitHub comment succeeds.",
	].join("\n");
}

async function executeReview(forgeHome: string, projectRoot: string, args: string, ctx: ExtensionContext): Promise<string> {
	const guidancePath = requireReviewerGuidance(forgeHome);
	const repo = repoFromConfig(projectRoot);
	const pr = resolveReviewPr(projectRoot, args);
	const prState = ghJson(projectRoot, ["pr", "view", String(pr), "-R", repo, "--json", "state,headRefOid"]) as { state?: string; headRefOid?: string };
	const headSha = String(prState.headRefOid || "").toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error(`PR #${pr} did not expose a valid full headRefOid`);
	if (prState.state === "MERGED") return `PR #${pr}: already merged at ${headSha.slice(0, 7)}.`;

	const readComments = () => {
		const pages = ghJson(projectRoot, ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments`]) as Array<Array<any>>;
		return pages.flat();
	};
	let comments = readComments();
	let admission = decideReviewRunAdmission({ comments, headSha, inline: false });
	if (admission.reason === "stale-active-claim" && admission.receipt) {
		const staleRun = admission.receipt;
		const recoveryId = `recover-${pr}-${Date.now()}-${randomUUID().slice(0, 8)}`;
		postPrComment(projectRoot, repo, pr, formatReviewRecoveryClaim({
			recoveryId, staleRunId: staleRun.runId, headSha, expiresAt: Date.now() + 120_000,
		}));
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
		comments = readComments();
		const recovery = electReviewRunRecovery({ comments, headSha, staleRunId: staleRun.runId, recoveryId });
		if (!recovery.won) throw new Error(`expired review recovery claim ${recoveryId} lost election to ${recovery.winner?.recoveryId || "another claimant"}`);
		admission = decideReviewRunAdmission({ comments, headSha, inline: false });
		if (admission.reason !== "stale-active-claim" || admission.receipt?.runId !== staleRun.runId) {
			throw new Error(`expired review run ${staleRun.runId} changed during recovery election`);
		}
		postPrComment(projectRoot, repo, pr, formatReviewRunReceipt({
			runId: staleRun.runId, headSha, state: "BLOCKED", mode: staleRun.mode,
			detail: `expired claim recovered by elected claimant ${recoveryId}`,
		}));
		comments = readComments();
		admission = decideReviewRunAdmission({ comments, headSha, inline: false });
	}
	if (admission.action === "reuse") return `PR #${pr}: adopted durable ${admission.receipt.state} review run.`;
	if (admission.action !== "start") throw new Error(`PR #${pr} already has ${admission.reason}; no duplicate panel launched`);

	const domains = ["security", "workflow", "runtime", "protocols"];
	const runId = `pi-${pr}-${Date.now()}-${randomUUID().slice(0, 8)}`;
	postPrComment(projectRoot, repo, pr, formatReviewRunReceipt({ runId, headSha, state: "STARTED", mode: "standalone", expiresAt: Date.now() + 35 * 60_000 }));
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
	comments = readComments();
	const election = electReviewRunClaim({ comments, headSha, runId });
	if (!election.won) {
		postPrComment(projectRoot, repo, pr, formatReviewRunReceipt({ runId, headSha, state: "SUPERSEDED", mode: "standalone", detail: `claim lost to ${election.winner?.runId || "another claimant"}` }));
		throw new Error(`review claim ${runId} lost election`);
	}

	const modelArgs = ctx.model?.provider && ctx.model?.id ? ["--model", `${ctx.model.provider}/${ctx.model.id}`] : [];
	const reviewResults = await Promise.all(domains.map(async (domain) => {
		const result = await runProcess(piExecutable(), ["--no-session", "--approve", "--no-extensions", ...modelArgs, "--name", `forge-review-${pr}-${domain}`, "-p", reviewAgentPrompt(guidancePath, repo, pr, domain, runId, headSha)], projectRoot, ctx.signal, 600_000);
		return { domain, result };
	}));
	comments = readComments();
	const completedDomains = scopedReviewerDomains(comments, { runId, headSha }).filter((domain) => domains.includes(domain));
	const scoped = comments.filter((comment) => {
		const body = String(comment.body || "");
		const markers = [...body.matchAll(/<!--\s*FORGE:REVIEW-AGENT:([a-z0-9-]+)\s*-->/gi)];
		return isTrustedReviewReceiptAuthor(comment)
			&& body.includes(`<!-- FORGE:REVIEW-RUN:${runId} -->`)
			&& body.toLowerCase().includes(`<!-- forge:review-sha:${headSha} -->`)
			&& markers.length === 1
			&& domains.includes(markers[0][1].toLowerCase());
	});
	const missing = domains.filter((domain) => !completedDomains.includes(domain));
	if (missing.length || reviewResults.some(({ result }) => result.timedOut || result.code !== 0)) {
		postPrComment(projectRoot, repo, pr, formatReviewRunReceipt({ runId, headSha, state: "BLOCKED", mode: "standalone", detail: `incomplete panel; missing ${missing.join(", ") || "worker failure"}` }));
		postPrComment(projectRoot, repo, pr, `<!-- FORGE:GATE_FAILURE:TYPE=review-panel-integrity -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${headSha} -->\n<!-- FORGE:REVIEW_BLOCKED -->\n## Review Blocked: Incomplete Isolated Review Panel\n\nSelected reviewers: ${domains.length}\nMissing receipts: ${missing.join(", ") || "none"}`);
		spawnSync("gh", ["pr", "edit", String(pr), "-R", repo, "--add-label", "review-degraded"], { cwd: projectRoot, windowsHide: true });
		throw new Error(`review panel incomplete: ${missing.join(", ") || "worker failure"}`);
	}
	const findings = scoped.filter((comment) => /<!-- FINDING:[^>]+ -->/.test(String(comment.body || "")));
	if (findings.length) {
		postPrComment(projectRoot, repo, pr, formatReviewRunReceipt({ runId, headSha, state: "CHANGES_REQUESTED", mode: "standalone", selected: domains.length, completed: domains.length }));
		postPrComment(projectRoot, repo, pr, `<!-- FORGE:GATE_FAILURE:TYPE=review-findings -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${headSha} -->\n## Review findings require triage\n\n${findings.length} structured finding comment(s) were produced.`);
		throw new Error("review produced findings; triage is required before a verdict");
	}
	spawnSync("gh", ["pr", "edit", String(pr), "-R", repo, "--remove-label", "review-degraded"], { cwd: projectRoot, windowsHide: true });
	postPrComment(projectRoot, repo, pr, `<!-- FORGE:GATE_PASS -->\n<!-- FORGE:REVIEW -->\n<!-- FORGE:REVIEW-RUN:${runId} -->\n<!-- FORGE:REVIEW-SHA:${headSha} -->\n## ForgeDock Review\n\n**Verdict**: PASS\n**Selected isolated reviewers**: ${domains.length}\n**Verified reviewer receipts**: ${domains.length}\n\nAll selected Pi reviewers completed and posted durable GitHub receipts.`);
	postPrComment(projectRoot, repo, pr, formatReviewRunReceipt({ runId, headSha, state: "COMPLETE", mode: "standalone", selected: domains.length, completed: domains.length }));
	return `PR #${pr}: PASS — ${domains.length} isolated reviewer receipts verified.`;
}

function sendPrompt(pi: ExtensionAPI, ctx: ExtensionCommandContext, prompt: string): void {
	pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

export default function forgedockPiExtension(pi: ExtensionAPI) {
	const forgeHome = process.env.FORGE_HOME || findForgeRoot(extensionDir()) || findForgeRoot(process.cwd()) || process.cwd();
	const commands = discoverCommands(forgeHome);
	const byName = new Map(commands.map((command) => [command.name, command]));

	const orchestrateHandler = async (args: string, ctx: ExtensionCommandContext) => {
		const projectRoot = findProjectRoot(ctx.cwd);
		try {
			ctx.ui.notify("Running deterministic ForgeDock preflight…", "info");
			ctx.ui.setWidget("forgedock-plan", ["ForgeDock is resolving issues and building the DAG…"]);
			const result = await orchestrate(forgeHome, projectRoot, args, ctx, /(?:^|\s)--(?:auto|confirm)(?:\s|$)/.test(args));
			ctx.ui.setWidget("forgedock-plan", undefined);
			ctx.ui.notify("ForgeDock orchestration finished", "info");
			pi.sendMessage({ customType: "forgedock-orchestration", content: result, display: true, details: { durablePiEngine: true } });
		} catch (error) {
			ctx.ui.setWidget("forgedock-plan", undefined);
			ctx.ui.notify(`ForgeDock orchestration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const reviewHandler = async (args: string, ctx: ExtensionCommandContext) => {
		try {
			const result = await executeReview(forgeHome, findProjectRoot(ctx.cwd), args, ctx);
			pi.sendMessage({ customType: "forgedock-review", content: result, display: true, details: { durableReview: true } });
		} catch (error) {
			ctx.ui.notify(`ForgeDock review blocked: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	const workOnHandler = async (args: string, ctx: ExtensionCommandContext) => {
		const projectRoot = findProjectRoot(ctx.cwd);
		try {
			const result = await executeIssue(forgeHome, projectRoot, args, ctx);
			pi.sendMessage({ customType: "forgedock-issue", content: formatIssueResult({ number: parseIssueNumber(args) || 0, status: issueResultStatus(result), ...result }), display: true, details: { durablePiEngine: true } });
		} catch (error) {
			ctx.ui.notify(`ForgeDock issue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerCommand("forge-orchestrate", { description: "Build and execute a durable Pi-backed ForgeDock DAG", handler: orchestrateHandler });
	pi.registerCommand("forge-work-on", { description: "Run one issue through the durable Pi-backed ForgeDock engine", handler: workOnHandler });
	pi.registerCommand("forge-review-pr", { description: "Run the verified multi-agent ForgeDock PR review panel", handler: reviewHandler });

	pi.registerTool({
		name: "forge_orchestrate", label: "Forge Orchestrate",
		description: "Resolve ForgeDock issues, present the dependency DAG, then run durable Pi-backed issue engines in parallel.",
		parameters: Type.Object({ input: Type.String({ description: "Issue query, milestone, issue numbers, or GitHub issue-search URL." }), includeInFlight: Type.Optional(Type.Boolean({ description: "Resume workflow:building and workflow:in-review issues." })), auto: Type.Optional(Type.Boolean({ description: "Skip the interactive confirmation checkpoint." })) }),
		async execute(_id, params, signal, _update, ctx) {
			const input = `${params.input}${params.includeInFlight ? " --include-in-flight" : ""}`;
			const result = await orchestrate(forgeHome, findProjectRoot(ctx.cwd), input, { ...ctx, signal } as ExtensionContext, Boolean(params.auto));
			return { content: [{ type: "text", text: result }], details: { input, durablePiEngine: true } };
		},
	});

	pi.registerTool({
		name: "forge_review_pr", label: "Forge Review PR",
		description: "Run the required isolated ForgeDock reviewer panel and fail closed unless every reviewer posts a durable receipt.",
		parameters: Type.Object({ pr: Type.Integer({ description: "GitHub pull request number" }) }),
		async execute(_id, params, signal, _update, ctx) {
			const result = await executeReview(forgeHome, findProjectRoot(ctx.cwd), String(params.pr), { ...ctx, signal } as ExtensionContext);
			return { content: [{ type: "text", text: result }], details: { durableReview: true } };
		},
	});

	pi.registerTool({
		name: "forge_work_on", label: "Forge Work On",
		description: "Run one GitHub issue through the durable Pi-backed ForgeDock engine in an isolated worktree.",
		parameters: Type.Object({ issue: Type.Integer({ description: "GitHub issue number" }) }),
		async execute(_id, params, signal, _update, ctx) {
			const result = await executeIssue(forgeHome, findProjectRoot(ctx.cwd), String(params.issue), { ...ctx, signal } as ExtensionContext);
			return { content: [{ type: "text", text: formatIssueResult({ number: params.issue, status: issueResultStatus(result), ...result }) }], details: { durablePiEngine: true } };
		},
	});

	pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("forgedock", commands.length ? `ForgeDock: ${commands.length} workflows` : "ForgeDock: unavailable"));
	pi.registerCommand("forge", { description: "Route work into a ForgeDock workflow", handler: async (args, ctx) => {
		const [first, ...rest] = args.trim().split(/\s+/); const key = first?.replace(/^\//, "").replace(/^forge[-:]?/, "").replace(/-/g, ":");
		if (key === "orchestrate") { await orchestrateHandler(rest.join(" "), ctx); return; }
		if (key === "work:on") { await workOnHandler(rest.join(" "), ctx); return; }
		if (key === "review:pr") { await reviewHandler(rest.join(" "), ctx); return; }
		const command = commands.find((item) => item.id === key || item.name === first);
		if (command) { sendPrompt(pi, ctx, `Read and execute ${command.absolutePath} for arguments: ${rest.join(" ") || "(none)"}. Follow the shared ForgeDock spec and use Pi-native runtime behavior.`); return; }
		ctx.ui.notify("Use /forge-work-on <issue> or /forge-orchestrate <query>.", "info");
	}});
	for (const command of commands) {
		if (byName.get(command.name) !== command || command.name === "forge-orchestrate" || command.name === "forge-work-on" || command.name === "forge-review-pr") continue;
		pi.registerCommand(command.name, { description: command.description, handler: async (args, ctx) => sendPrompt(pi, ctx, `Read and execute ${command.absolutePath} for arguments: ${args || "(none)"}. Follow the shared ForgeDock spec.`) });
	}

	pi.registerTool({
		name: "forge_subagent", label: "Forge Subagent", description: "Run an isolated Pi subprocess for ForgeDock review or subtask work.",
		parameters: Type.Object({ prompt: Type.String(), label: Type.Optional(Type.String()), readOnly: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, signal, _update, ctx) {
			const result = await runProcess(piExecutable(), ["--no-session", "--approve", "--name", params.label || "forge-subagent", ...(params.readOnly ? ["--tools", "read,grep,find,ls,bash"] : []), "-p", params.prompt], ctx.cwd, signal);
			return { content: [{ type: "text", text: `exit_code=${result.code}\n${result.stdout}\n${result.stderr}` }], details: result, isError: result.code !== 0 };
		},
	});
}
