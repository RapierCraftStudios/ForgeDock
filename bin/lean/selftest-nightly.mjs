// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Opt-in nightly `selftest --live` (#4894), started from schedd's due callback on the host (never GitHub Actions). Off unless
// forge.yaml `selftest.nightly_interval_hours` is a positive number. The daemon only decides it is due and launches a
// detached `forgedock selftest --live --nightly-report <repo>`: the harness itself talks to schedd (orchestrate --add), so
// running it inside the daemon's event loop would deadlock it, and a 45-minute run would hold the due pass. A failing run
// (or one that cannot start, e.g. no sandbox repo) files ONE issue naming the failed step; the next failure edits it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schedDir } from "./sched.mjs";

export const NIGHTLY_MARKER = "<!-- FORGE:SELFTEST_NIGHTLY -->";
const neutralize = (s) => String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** One last-run file per repo: two repos on one host never share (and so never skip) each other's schedule. */
const stateFile = (repo) => `selftest-nightly-${String(repo).replace(/[^\w.-]+/g, "_")}.json`;

/** Interval in hours from the forge.yaml text, or null when the key is unset, zero or not a number (= nothing scheduled). */
export function nightlyConfig(raw) {
  const sec = String(raw ?? "").split(/^selftest:/m)[1]?.split(/^\S/m)[0] ?? "";
  const h = Number(/^\s+nightly_interval_hours:\s*["']?([\d.]+)/m.exec(sec)?.[1]);
  return h > 0 ? h : null;
}

function readLast(dir, repo) {
  try { return Number(JSON.parse(readFileSync(join(dir, stateFile(repo)), "utf8")).lastRun) || 0; } catch { return 0; }
}
function writeLast(dir, repo, ts) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, stateFile(repo)), JSON.stringify({ lastRun: ts }));
}

/**
 * Start `node <cli> selftest --live --nightly-report <repo>` detached, from the daemon. A spawn failure (EAGAIN, EMFILE,
 * a vanished cwd) arrives as an async 'error' event: without a listener it is an uncaught exception, which stops schedd.
 * It is swallowed here; that night's run is lost, never the daemon.
 */
export function launchNightly({ cli, repo, cwd = process.cwd(), spawnFn = spawn }) {
  try {
    const c = spawnFn(process.execPath, [cli, "selftest", "--live", "--nightly-report", repo], { cwd, detached: true, windowsHide: true, stdio: "ignore" });
    c.on("error", () => {});
    c.unref();
    return c;
  } catch { return null; }
}

/** File (or edit) the one nightly failure issue in `repo`. `result` is {step, message}. @returns {Promise<{issue:?number, action:"create"|"edit"}>} */
export async function reportNightly({ repo, io, now = () => Date.now(), result }) {
  const step = result?.step ?? "unknown";
  const title = `selftest --live failed at step ${step} (nightly)`;
  const body = `The nightly \`forgedock selftest --live\` failed at step **${neutralize(step)}**.\n\n${neutralize(String(result?.message ?? "").slice(0, 2000))}\n\nLast failure: ${new Date(now()).toISOString()}\n\n${NIGHTLY_MARKER}\n`;
  const open = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--search", `"FORGE:SELFTEST_NIGHTLY" in:body`, "--limit", "30", "--json", "number,body"])))
    .find((i) => String(i.body ?? "").includes(NIGHTLY_MARKER));
  if (open) {
    await io.gh(["issue", "edit", String(open.number), "-R", repo, "--title", title, "--body", body]);
    return { issue: open.number, action: "edit" };
  }
  const out = await io.gh(["issue", "create", "-R", repo, "--title", title, "--body", body]);
  return { issue: Number(/(\d+)\s*$/.exec(String(out).trim())?.[1]) || null, action: "create" };
}

/**
 * One schedd pass. With `launch` (the daemon) it only starts the detached run and returns {ran, launched}; with `runLive`
 * (tests, or an in-process caller) it awaits {ok, step, message} and files the failure. A harness that throws is a
 * failure at step "harness", never silent. Never throws.
 * @returns {Promise<{ran:boolean, launched?:boolean, ok?:boolean, issue?:?number, action?:"create"|"edit"}>}
 */
export async function nightlyDue({ repo, cwd = process.cwd(), io, now = () => Date.now(), runLive, launch, stateDir = schedDir() } = {}) {
  try {
    const file = join(cwd, "forge.yaml");
    const hours = nightlyConfig(existsSync(file) ? readFileSync(file, "utf8") : "");
    if (!hours || !repo) return { ran: false };
    if (now() - readLast(stateDir, repo) < hours * 3600_000) return { ran: false };
    writeLast(stateDir, repo, now()); // before the run: a crashing harness must not re-run every 15 min
    if (launch) { launch(); return { ran: true, launched: true }; }
    let r;
    try { r = await runLive(); } catch (e) { r = { ok: false, step: "harness", message: String(e?.message ?? e) }; }
    if (r.ok) return { ran: true, ok: true };
    return { ran: true, ok: false, ...(await reportNightly({ repo, io, now, result: r })) };
  } catch { return { ran: false }; }
}
