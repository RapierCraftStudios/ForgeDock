// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Core work-on session runner on the Pi harness (`pi -p --mode json`): same contract as makeLeanRunner, so runCore,
 * its prompts and its reviewer run unchanged on any model Pi can reach. Bare Pi: no extensions, skills, prompt
 * templates or project-local .pi settings, so the session sees only the harness, the repo's context files and our prompt.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PI_READ_ONLY_TOOLS = "read,grep,find,ls";
export const piSessionDir = () => join(homedir(), ".forge", "pi-sessions");

/** argv for one Pi session. A resume reuses the builder's session id; the prompt goes on stdin (no argv size limit). */
export function buildPiArgs({ sessionId, sessionDir, model = null, system = "", readOnly = false }) {
  return ["-p", "--mode", "json", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve",
    "--session-dir", sessionDir, "--session-id", sessionId,
    ...(model ? ["--model", model] : []),
    ...(system ? ["--append-system-prompt", system] : []),
    ...(readOnly ? ["--tools", PI_READ_ONLY_TOOLS] : [])];
}

/** Fold Pi's JSON event stream into the runner result: last assistant text, summed usage/cost, turns, model. */
export function parsePiEvents(lines) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let text = "", costUsd = 0, turns = 0, model = null, error = null;
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e?.message;
    if (e?.type !== "message_end" || m?.role !== "assistant") continue;
    turns++;
    const u = m.usage ?? {};
    usage.input_tokens += u.input ?? 0; usage.output_tokens += u.output ?? 0;
    usage.cache_read_input_tokens += u.cacheRead ?? 0; usage.cache_creation_input_tokens += u.cacheWrite ?? 0;
    costUsd += u.cost?.total ?? 0;
    if (m.model) model = m.provider ? `${m.provider}/${m.model}` : m.model;
    const t = (m.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n").trim();
    if (t) text = t;
    error = m.stopReason === "error" ? (m.errorMessage ?? "pi session ended with an error") : null;
  }
  return { text, usage, costUsd, turns, model, error };
}

export function makePiRunner({ bin = "pi", sessionDir = piSessionDir(), spawnFn = spawn, newId = randomUUID } = {}) {
  return ({ role, cwd, model, resume, system, prompt, readOnly = false, env = null, idleMs = 0, maxMs = 0, control = null }) => new Promise((resolveP, rejectP) => {
    mkdirSync(sessionDir, { recursive: true });
    const sessionId = resume ?? newId();
    const args = buildPiArgs({ sessionId, sessionDir, model, system: resume ? "" : system, readOnly });
    const started = Date.now();
    let child;
    try { child = spawnFn(bin, args, { cwd, env: { ...process.env, ...(env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], detached: true }); }
    catch (e) { return rejectP(Object.assign(e, { code: "CLI_SPAWN_FAILED", spawnDeterministic: true })); }
    const lines = []; let buf = "", stderr = "", lastActivity = started, paused = false, pausedAt = 0, pausedTotal = 0, killedFor = null;
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    if (control && typeof control === "object") Object.assign(control, {
      pause() { if (paused) return false; paused = true; pausedAt = Date.now(); group("SIGSTOP"); return true; },
      resume() { if (!paused) return false; paused = false; pausedTotal += Date.now() - pausedAt; lastActivity = Date.now(); group("SIGCONT"); return true; },
      isPaused: () => paused,
    });
    const kill = (why) => { killedFor = why; if (paused) { paused = false; group("SIGCONT"); } group("SIGTERM"); setTimeout(() => group("SIGKILL"), 5000).unref?.(); };
    const timer = setInterval(() => {
      if (killedFor || paused) return;
      const now = Date.now();
      if (idleMs > 0 && now - lastActivity >= idleMs) kill("idle");
      else if (maxMs > 0 && now - started - pausedTotal >= maxMs) kill("timeout");
    }, Math.max(20, Math.min(1000, (idleMs || 4000) / 4)));
    timer.unref?.();
    child.stdout.on("data", (d) => {
      lastActivity = Date.now(); buf += d.toString("utf-8");
      let nl; while ((nl = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
    });
    child.stderr.on("data", (d) => { lastActivity = Date.now(); if (stderr.length < 1_000_000) stderr += d.toString("utf-8"); });
    child.stdin.on("error", () => { /* exited before reading: surfaced by close */ });
    child.stdin.end(String(prompt ?? ""));
    child.on("error", (e) => { clearInterval(timer); rejectP(Object.assign(e, { code: "CLI_SPAWN_FAILED", spawnDeterministic: ["ENOENT", "EACCES", "ENOEXEC"].includes(e?.code) })); });
    child.on("close", (status) => {
      clearInterval(timer);
      if (buf.trim()) lines.push(buf.trim());
      const r = parsePiEvents(lines);
      const durationMs = Date.now() - started;
      if (killedFor) return rejectP(Object.assign(new Error(`pi ${role} session ${killedFor === "idle" ? `idle for ${idleMs}ms` : `exceeded ${maxMs}ms`}`), { code: killedFor === "idle" ? "CLI_IDLE" : "CLI_TIMEOUT" }));
      if (status !== 0 || (r.error && !r.text)) return rejectP(new Error(`pi ${role} session failed (exit ${status}): ${String(r.error ?? stderr).trim().slice(0, 500)}`));
      resolveP({ text: r.text, sessionId, usage: r.usage, costUsd: r.costUsd, durationMs, turns: r.turns, model: r.model ?? model ?? "default" });
    });
  });
}
