// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Node twin of scripts/lib/telemetry.sh: same record shape, same upsert into the trusted
 * `<!-- FORGE:TELEMETRY v1 -->` comment, same rollover and local buffer. emit() NEVER throws and never
 * rejects its caller; FORGE_TELEMETRY=off disables it. Records hold ids, counts and codes only.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const RESERVED = new Set(["v", "ts", "forge_version", "repo", "issue", "pr", "run", "phase", "event", "eid"]);
const MARKER_RE = /^<!-- FORGE:TELEMETRY v1( part=(\d+))? -->/;
const REVIEW_SIDE = new Set(["review_panel", "finding_disposition", "ci_gate"]);

const clean = (v) => String(v).replace(/[\n\r\t]/g, " ").replace(/[^A-Za-z0-9 _.:/#@+=,-]/g, "_").slice(0, 200);
const num = (s) => (/^[0-9]+$/.test(s ?? "") ? Number(s) : null);
const str = (s) => (s ? String(s) : null);

function forgeVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || null; } catch { return null; }
}

/** Same JSON line the shell emitter writes (key order included). `ctx` overrides the FORGE_* env. */
export function buildRecord(event, payload = {}, ctx = {}, now = new Date()) {
  const env = process.env;
  const c = {
    repo: ctx.repo ?? env.FORGE_REPO, issue: ctx.issue ?? env.FORGE_ISSUE, pr: ctx.pr ?? env.FORGE_PR,
    run: ctx.run ?? env.FORGE_RUN, phase: ctx.phase ?? env.FORGE_PHASE,
  };
  const extra = {};
  for (const [k, raw] of Object.entries(payload)) {
    if (!/^[A-Za-z0-9_]+$/.test(k) || RESERVED.has(k)) continue;
    const v = clean(raw);
    extra[k] = /^-?[0-9]+$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
  }
  return {
    v: 1, ts: now.toISOString().replace(/\.\d+Z$/, "Z"), forge_version: forgeVersion(), repo: str(c.repo),
    issue: num(String(c.issue ?? "")), pr: num(String(c.pr ?? "")), run: str(c.run), phase: str(c.phase), event,
    eid: `${Math.floor(now.getTime() / 1000)}-${process.pid}-${randomBytes(4).toString("hex")}`, ...extra,
  };
}

function target(event, rec) {
  const order = REVIEW_SIDE.has(event) ? [rec.pr, rec.issue] : [rec.issue, rec.pr];
  const n = order.find((x) => x != null);
  return n != null && rec.repo && rec.repo.includes("/") ? n : null;
}

function gh(args) {
  const bin = process.env.FORGE_TELEMETRY_GH || "gh";
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error("gh failed");
  return r.stdout;
}

function trusted(comment) {
  const tc = join(ROOT, "scripts", "trusted-comments.sh");
  const r = spawnSync("bash", [tc, "count", MARKER_RE.source], { input: JSON.stringify([comment]), encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "1";
}

function upsert(repo, n, lines) {
  const max = Number(process.env.FORGE_TELEMETRY_MAX_CHARS) || 60000;
  const raw = gh(["api", "--paginate", `repos/${repo}/issues/${n}/comments`]).trim();
  const pages = raw ? JSON.parse(`[${raw.replace(/\]\s*\[/g, "],[")}]`) : [[]];
  let best = null;
  const parts = [];
  for (const c of pages.flat()) {
    const m = MARKER_RE.exec(c.body || "");
    if (!m || !trusted(c)) continue;
    const part = m[2] ? Number(m[2]) : 1;
    parts.push({ body: c.body });
    if (!best || part >= best.part) best = { id: c.id, part, body: c.body };
  }
  const all = parts.map((p) => p.body).join("\n");
  const fresh = lines.filter((l) => !all.includes(l));
  if (fresh.length === 0) return;
  if (best) {
    const cut = best.body.lastIndexOf("\n```");
    const out = `${cut >= 0 ? best.body.slice(0, cut) : best.body}\n${fresh.join("\n")}\n\`\`\``;
    if (out.length <= max) { gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${best.id}`, "-f", `body=${out}`]); return; }
  }
  const hdr = best ? `<!-- FORGE:TELEMETRY v1 part=${best.part + 1} -->` : "<!-- FORGE:TELEMETRY v1 -->";
  gh(["api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "-f", `body=${hdr}\n\`\`\`jsonl\n${fresh.join("\n")}\n\`\`\``]);
}

/** Emit one event. Returns the record when written or buffered, null when disabled/dropped. Never throws. */
export function emit(event, payload = {}, ctx = {}) {
  try {
    if ((process.env.FORGE_TELEMETRY || "on") === "off") return null;
    if (!/^[A-Za-z0-9_.-]+$/.test(event || "")) return null;
    const rec = buildRecord(event, payload, ctx);
    const n = target(event, rec);
    if (n == null) return null;
    const dir = process.env.FORGE_TELEMETRY_BUFFER_DIR || join(homedir(), ".forge", "telemetry-buffer");
    const buf = join(dir, `${rec.repo.replace("/", "_")}__${n}.jsonl`);
    const line = JSON.stringify(rec);
    // Per-target lock (mkdir is atomic): serializes emitters on this host so the unversioned GitHub read-modify-write
    // cannot lose a record or double-POST a part. A lock over 60s old is stale; on timeout the record is buffered.
    let canLock = true;
    try { mkdirSync(dir, { recursive: true }); } catch { canLock = false; }
    const lock = join(dir, `.lock-${rec.repo.replace("/", "_")}__${n}`);
    let got = !canLock;
    for (let i = 0; i < 100 && !got; i++) {
      try { mkdirSync(lock); got = true; } catch {
        try { if (Date.now() - statSync(lock).mtimeMs > 60000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
        spawnSync("sleep", ["0.1"]);
      }
    }
    if (!got) { appendFileSync(buf, `${line}\n`); return rec; }
    // Claim the buffer by renaming it: records appended meanwhile land in a fresh file and are never deleted.
    const claimed = `${buf}.flush.${process.pid}`;
    let pending = [line];
    try { if (existsSync(buf)) { renameSync(buf, claimed); pending = [...readFileSync(claimed, "utf8").split("\n").filter(Boolean), line]; } } catch { /* nothing claimed */ }
    try {
      upsert(rec.repo, n, pending);
      rmSync(claimed, { force: true });
    } catch {
      try {
        if (existsSync(claimed)) { appendFileSync(buf, readFileSync(claimed, "utf8")); rmSync(claimed, { force: true }); }
        appendFileSync(buf, `${line}\n`);
      } catch { /* lost record costs completeness only */ }
    } finally { if (canLock) rmSync(lock, { recursive: true, force: true }); }
    return rec;
  } catch {
    return null;
  }
}
