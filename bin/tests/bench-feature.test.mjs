import { test } from "node:test";
import * as cp from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./_tmp.mjs";
import { aggregate, loadSpec, main, parseRows, runArm, validateRunConfig } from "../../scripts/bench-feature.mjs";
import { scoreboardGate } from "../stats/scoreboard.mjs";

const SPEC = new URL("../../docs/eval/feature-specs/crud-auth", import.meta.url).pathname;
const CFG = { arms: { full: { repo: "acme/sandbox" }, control: { model: "claude-opus-5-5" } } };
const GOOD_APP = `export function createApp() {
  const users = new Map(), tokens = new Map(), notes = [];
  let n = 0;
  const who = (h) => tokens.get(String(h?.authorization ?? "").replace("Bearer ", ""));
  return { async handle({ method, path, headers, body }) {
    if (path === "/register") return users.has(body?.username) ? { status: 409 } : body?.username && body?.password ? (users.set(body.username, body.password), { status: 201 }) : { status: 400 };
    if (path === "/login") { if (users.get(body?.username) !== body?.password) return { status: 401 }; const t = "t" + ++n; tokens.set(t, body.username); return { status: 200, body: { token: t } }; }
    const u = who(headers); if (!u) return { status: 401 };
    if (path === "/notes" && method === "POST") { const x = { id: ++n, text: body.text, u }; notes.push(x); return { status: 201, body: { id: x.id, text: x.text } }; }
    if (path === "/notes") return { status: 200, body: notes.filter((x) => x.u === u) };
    const x = notes.find((y) => y.id === Number(path.split("/")[2]) && y.u === u);
    if (!x) return { status: 404 };
    if (method === "DELETE") notes.splice(notes.indexOf(x), 1); else x.text = body.text;
    return { status: 200 };
  } };
}
`;

/** Fake runner: node journeys run for real in the app dir; the control writes `controlApp`, the full arm's clone gets `fullApp`. */
function fakeRun({ controlApp = GOOD_APP, fullApp = GOOD_APP } = {}) {
  const calls = [];
  const { spawnSync } = cp;
  const run = async (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === "claude") { if (controlApp) writeFileSync(join(opts.cwd, "app.mjs"), controlApp); return { code: 0, stdout: JSON.stringify({ total_cost_usd: 0.5, duration_ms: 1000 }), stderr: "" }; }
    if (cmd === "forgedock") { if (args.includes("--result-file")) writeFileSync(args[args.indexOf("--result-file") + 1], JSON.stringify({ cost_usd: 4, wall_ms: 9000, interventions: 1 })); return { code: 0, stdout: "", stderr: "" }; }
    if (cmd === "git") { mkdirSync(args.at(-1), { recursive: true }); writeFileSync(join(args.at(-1), "app.mjs"), fullApp); return { code: 0, stdout: "", stderr: "" }; }
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  return { run, calls };
}

test("loadSpec reads the spec and its hidden journeys; a spec without journeys is refused", () => {
  const s = loadSpec(SPEC);
  assert.equal(s.id, "crud-auth");
  assert.deepEqual(s.journeys.map((j) => j.name), ["notes-crud-isolated", "register-login"]);
  assert.throws(() => loadSpec(tmpDir("bf-empty")), /spec\.md missing/);
});

test("validateRunConfig names the missing field", () => {
  assert.throws(() => validateRunConfig({ arms: { full: { repo: "nope" } } }, ["full"]), /owner\/name/);
  assert.throws(() => validateRunConfig({ arms: {} }, ["control"]), /arms\.control/);
  assert.equal(validateRunConfig(CFG, ["full", "control"]), CFG);
});

test("one spec end to end: both arms are graded by the journeys and report journeys passed", async () => {
  const dir = tmpDir("bf-e2e"), rows = join(dir, "rows.jsonl"), cfg = join(dir, "cfg.json");
  writeFileSync(cfg, JSON.stringify(CFG));
  const { run, calls } = fakeRun({ controlApp: "export const createApp = () => ({ handle: async () => ({ status: 500 }) });\n" });
  const err = { write() {} };
  assert.equal(await main(["run", "--spec", SPEC, "--config", cfg, "--out", rows], { run, err }), 0);
  const [full, control] = parseRows(await import("node:fs").then((f) => f.readFileSync(rows, "utf8")));
  assert.equal(full.arm, "full");
  assert.equal(full.journeys_passed, 2);
  assert.equal(full.interventions, 1);
  assert.equal(control.journeys_passed, 0);
  assert.equal(control.journeys_total, 2);
  assert.deepEqual(calls.filter((c) => c[0] === "forgedock").map((c) => c[1]), ["bootstrap", "orchestrate", "release"]);
  const agg = aggregate([full, control]);
  assert.equal(agg.arms.full.journey_pass_rate, 1);
  assert.equal(agg.targets.full_journeys_ge_control.pass, true);
  assert.equal(agg.record.schema, "forge.bench.v1");
});

test("a failing forgedock step stops the full arm and the journeys fail", async () => {
  const dir = tmpDir("bf-fail");
  const run = async (cmd, args, o = {}) => (cmd === "forgedock" ? { code: 3, stdout: "", stderr: "" } : cmd === "git" ? (mkdirSync(args.at(-1), { recursive: true }), { code: 0, stdout: "", stderr: "" }) : { code: 1, stdout: "", stderr: "" });
  const row = await runArm({ arm: "full", spec: loadSpec(SPEC), cfg: CFG, run, tmp: dir });
  assert.match(row.terminal, /bootstrap exit 3/);
  assert.equal(row.journeys_passed, 0);
});

test("aggregate flags a regression against the previous scorecard and the gate refuses it", async () => {
  const row = (arm, p) => ({ arm, journeys_total: 2, journeys_passed: p, cost_usd: 1, wall_ms: 1, interventions: 0 });
  const prev = aggregate([row("full", 2), row("control", 1)]);
  const cur = aggregate([row("full", 1), row("control", 1)], { previous: prev });
  assert.match(cur.regression, /0\.5 < previous 1/);
  assert.equal(aggregate([row("full", 2), row("control", 1)], { previous: prev }).regression, null);
  assert.equal(scoreboardGate({ bench: cur }).ok, false);
  assert.equal(scoreboardGate({ bench: prev }).ok, true);
  const dir = tmpDir("bf-agg");
  writeFileSync(join(dir, "rows.jsonl"), [row("full", 1), row("control", 1)].map((r) => JSON.stringify(r)).join("\n"));
  writeFileSync(join(dir, "prev.json"), JSON.stringify(prev));
  const out = { s: "", write(t) { this.s += t; } };
  assert.equal(await main(["aggregate", join(dir, "rows.jsonl"), "--previous", join(dir, "prev.json")], { out }), 2);
  assert.match(out.s, /regression/);
});
