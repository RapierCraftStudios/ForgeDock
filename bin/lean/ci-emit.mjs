// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runner-side CI event emitter (#5689, parent #5687): `forgedock ci-step --name <step> -- <cmd...>` and
 * `forgedock ci-hook job-started|job-completed`. Events go to the router's POST /ci/events (#5688).
 * - Delivery is best effort: a failed POST logs one warning line, stops further posts and never changes the exit code.
 * - Config: FORGEDOCK_CI_EVENTS_URL (fallback FORGE_CI_EVENTS_URL, as ci-preflight.mjs) + FORGEDOCK_CI_TOKEN (bearer). Unset URL: no posts.
 */
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { StringDecoder } from "node:string_decoder";

export const POST_TIMEOUT_MS = 1000, DRAIN_MS = 1500, MAX_LINES = 40, MAX_LINE_CHARS = 500, MAX_MESSAGE_CHARS = 2000;
const ERROR_RE = /error|fail|traceback|assert/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

/** Base event fields from the GitHub Actions env; the router requires repo, sha, run_id, job and ts. */
export function baseEvent(env = process.env, now = () => new Date()) {
  const ev = {
    repo: nonEmpty(env.GITHUB_REPOSITORY) || "unknown",
    sha: nonEmpty(env.GITHUB_SHA) || "unknown",
    run_id: nonEmpty(env.GITHUB_RUN_ID) || "unknown",
    job: nonEmpty(env.GITHUB_JOB) || "unknown",
    ts: now().toISOString(),
  };
  const m = /^refs\/pull\/(\d{1,9})\//.exec(nonEmpty(env.GITHUB_REF));
  if (m) ev.pr = Number(m[1]);
  return ev;
}

/** Fire-and-forget poster. `post` never throws; `drain` waits for in-flight posts for at most DRAIN_MS. */
export function createPoster({ env = process.env, fetchImpl = globalThis.fetch, warn = (l) => process.stderr.write(`${l}\n`), now = () => new Date() } = {}) {
  const url = nonEmpty(env.FORGEDOCK_CI_EVENTS_URL) || nonEmpty(env.FORGE_CI_EVENTS_URL);
  const token = nonEmpty(env.FORGEDOCK_CI_TOKEN);
  const pending = new Set();
  let broken = false;
  const fail = (why) => {
    if (broken) return;
    broken = true;
    warn(`forgedock ci-emit: event delivery failed (${why}); continuing without events`);
  };
  return {
    enabled: Boolean(url) && typeof fetchImpl === "function",
    post(type, fields = {}) {
      if (!url || typeof fetchImpl !== "function" || broken) return;
      const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
      const body = JSON.stringify({ type, ...baseEvent(env, now), ...fields });
      const p = Promise.resolve()
        .then(() => fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) }))
        .then((res) => { if (!res || res.status >= 300) fail(`HTTP ${res ? res.status : "no response"}`); })
        .catch((err) => fail(err?.name === "TimeoutError" ? "timeout" : (err?.cause?.code ?? err?.message ?? "error")))
        .finally(() => pending.delete(p));
      pending.add(p);
    },
    async drain() {
      if (!pending.size) return;
      let timer;
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => { timer = setTimeout(r, DRAIN_MS); })]);
      clearTimeout(timer);
      if (pending.size) fail("timeout");
    },
  };
}

/** Streaming parser for pytest (-rA) and vitest/jest default-reporter lines; `onFail({id,file,line,message})` fires as soon as a test is known. */
export function createTestParser(onFail) {
  const seen = new Set();
  const loc = new Map(); // pytest: file -> {line, message} from `path:line: Error` lines
  let pend = null; // vitest: FAIL seen, waiting for its `❯ file:line`
  const emit = (t) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    const test = { id: clip(t.id, 500) };
    if (t.file) test.file = clip(t.file, 500);
    if (Number.isInteger(t.line)) test.line = t.line;
    if (t.message) test.message = clip(t.message, MAX_MESSAGE_CHARS);
    onFail(test);
  };
  const flush = () => { if (pend) { emit(pend); pend = null; } };
  return {
    line(raw) {
      const s = raw.replace(ANSI_RE, "").replace(/\r$/, "");
      let m = /^FAILED\s+(\S+?)::(\S+)(?:\s+-\s+(.*))?$/.exec(s.trim());
      if (m) {
        const l = loc.get(m[1]);
        emit({ id: `${m[1]}::${m[2]}`, file: m[1], line: l?.line, message: m[3] || l?.message });
        return;
      }
      m = /^(\S+\.[A-Za-z]+):(\d+):\s+(\S*(?:Error|Exception|Failed)\S*)\s*(.*)$/.exec(s.trim());
      if (m) { loc.set(m[1], { line: Number(m[2]), message: `${m[3]} ${m[4]}`.trim() }); return; }
      m = /^\s*(?:FAIL|×)\s+(?:\[[^\]]*\]\s+)?(\S+)\s+>\s+(.+?)(?:\s+\d+ms)?\s*$/.exec(s);
      if (m) { flush(); pend = { id: `${m[1]} > ${m[2]}`, file: m[1] }; return; }
      if (!pend) return;
      m = /^\s*❯\s+(\S+?):(\d+)(?::\d+)?\s*$/.exec(s);
      if (m && (m[1] === pend.file || m[1].endsWith(pend.file) || pend.file.endsWith(m[1]))) { pend.line = Number(m[2]); flush(); return; }
      if (!pend.message && /(Error|expected)/.test(s) && !s.includes("❯")) pend.message = s.trim();
    },
    end() { flush(); },
  };
}

/** Keeps the first MAX_LINES error-looking lines, else the last MAX_LINES lines. */
function createLineKeeper() {
  const errs = [], tail = [];
  return {
    add(line) {
      const l = clip(line.replace(ANSI_RE, ""), MAX_LINE_CHARS);
      if (errs.length < MAX_LINES && ERROR_RE.test(l)) errs.push(l);
      tail.push(l);
      if (tail.length > MAX_LINES) tail.shift();
    },
    result() { return errs.length ? errs : tail; },
  };
}

function lineSplitter(onLine) {
  const dec = new StringDecoder("utf8");
  let buf = "";
  const take = (text) => {
    buf += text;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
  };
  return { write: (chunk) => take(dec.write(chunk)), end() { take(dec.end()); if (buf) { onLine(buf); buf = ""; } } };
}

export const CI_STEP_USAGE = "usage: forgedock ci-step --name <step> -- <cmd...>";

/** `forgedock ci-step`; @returns the wrapped command's exit code (128+signal when killed). `deps`: {env, fetchImpl, stdout, stderr, warn, now, spawnImpl}. */
export async function ciStepFromCli(argv, deps = {}) {
  const env = deps.env ?? process.env, stdout = deps.stdout ?? process.stdout, stderr = deps.stderr ?? process.stderr;
  const sep = argv.indexOf("--");
  const head = sep < 0 ? argv : argv.slice(0, sep), cmd = sep < 0 ? [] : argv.slice(sep + 1);
  const ni = head.indexOf("--name");
  const name = ni >= 0 ? nonEmpty(head[ni + 1]) : "";
  if (!name || !cmd.length) { stderr.write(`${CI_STEP_USAGE}\n`); return 2; }

  const poster = createPoster({ env, fetchImpl: deps.fetchImpl, warn: deps.warn ?? ((l) => stderr.write(`${l}\n`)), now: deps.now });
  const keeper = createLineKeeper();
  const parser = createTestParser((test) => poster.post("test_failed", { step: name, test }));
  const feed = (line) => { keeper.add(line); parser.line(line); };
  const split = { out: lineSplitter(feed), err: lineSplitter(feed) };

  poster.post("step_started", { step: name });
  const code = await new Promise((resolve) => {
    let child;
    try { child = (deps.spawnImpl ?? spawn)(cmd[0], cmd.slice(1), { stdio: ["inherit", "pipe", "pipe"], env }); } catch (err) { stderr.write(`ci-step: cannot run ${cmd[0]}: ${err.message}\n`); resolve(127); return; }
    child.stdout.on("data", (c) => { stdout.write(c); split.out.write(c); });
    child.stderr.on("data", (c) => { stderr.write(c); split.err.write(c); });
    child.on("error", (err) => { stderr.write(`ci-step: cannot run ${cmd[0]}: ${err.message}\n`); resolve(err.code === "ENOENT" ? 127 : 126); });
    child.on("close", (c, sig) => resolve(sig ? 128 + (osConstants.signals[sig] ?? 0) : (c ?? 1)));
  });
  split.out.end(); split.err.end(); parser.end();
  if (code !== 0) poster.post("step_failed", { step: name, exit_code: code, lines: keeper.result() });
  await poster.drain();
  return code;
}

const HOOKS = { "job-started": "job_started", "job-completed": "job_finished" };
export const CI_HOOK_USAGE = "usage: forgedock ci-hook job-started|job-completed";

/** `forgedock ci-hook`; always @returns 0 (a runner hook must never fail the job) except for a usage error. */
export async function ciHookFromCli(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const type = HOOKS[argv[0]];
  if (!type) { (deps.stderr ?? process.stderr).write(`${CI_HOOK_USAGE}\n`); return 2; }
  const poster = createPoster({ env, fetchImpl: deps.fetchImpl, warn: deps.warn, now: deps.now });
  if (!poster.enabled) return 0;
  poster.post(type);
  await poster.drain();
  return 0;
}
