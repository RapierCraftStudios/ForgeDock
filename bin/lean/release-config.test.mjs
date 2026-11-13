// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../tests/_tmp.mjs";
import { parsePolicy, validatePolicy, readPolicy, INIT_PROFILE, checkConfigFromCli, dockerfileCoverage, dockerfileSources, initFromCli, POLICY_PATH } from "./release-config.mjs";
import { releaseFromCli } from "./release.mjs";

const OK = `schema: 1
branches: {default: main, integration: staging}
units:
  api: {paths: ["services/api/**"], criticality: high}
  web: {paths: ["web/**"]}
couplings:
  - {paths: ["shared/**"], affects: [api, web]}
lanes:
  release: {pipeline: full, ci_tier: T3, base: integration}
deploy:
  pipelines:
    full: {workflow: deploy.yml, trigger: push, wait: true}
ci:
  tiers: {T3: {jobs: [e2e]}}
`;
const check = (text) => { const r = parsePolicy(text); return r.error ? [`parse: ${r.error}`] : validatePolicy(r.policy); };
const ioFor = (files, calls = []) => ({ calls, printed: [], print(l) { this.printed.push(l); }, git: (a) => { calls.push(a); const t = files[a[1]]; if (t === undefined) throw new Error("missing"); return t; } });

describe("validate", () => {
  it("accepts a full policy and the init profile", () => {
    assert.deepEqual(check(OK), []);
    assert.deepEqual(check(INIT_PROFILE), []);
  });
  it("fails closed: unknown key, wrong type, duplicate key, bad schema", () => {
    assert.match(check(OK + "bogus: 1\n").join(), /bogus: unknown key/);
    assert.match(check(OK.replace("criticality: high", "criticality: extreme")).join(), /criticality/);
    assert.match(check(OK.replace("paths: [\"web/**\"]", "paths: web")).join(), /expected a list/);
    assert.match(check(OK + "plan: {approval: wait}\nplan: {approval: auto}\n").join(), /parse: .*duplicated mapping key/);
    assert.match(check("branches: {default: main}\n").join(), /schema/);
    assert.match(check("schema: 2\n").join(), /not one of 1/);
  });
  it("unreachable lanes fail", () => {
    assert.match(check(OK.replace("pipeline: full, ci_tier", "pipeline: nope, ci_tier")).join(), /pipeline nope is not in deploy.pipelines/);
    assert.match(check(OK.replace("ci_tier: T3", "ci_tier: T9")).join(), /ci_tier T9/);
    assert.match(check(OK.replace(", integration: staging", "")).join(), /branches.integration is not set/);
    assert.match(check(OK.replace("affects: [api, web]", "affects: [api, ghost]")).join(), /unit ghost/);
  });
});

describe("ci.fix (#5567)", () => {
  it("accepts max_rounds, co_start and full_run_workflow; rejects unknown keys and a non-integer max_rounds", () => {
    assert.deepEqual(check(OK.replace("ci:\n", "ci:\n  fix: {max_rounds: 1, co_start: true, full_run_workflow: full.yml}\n")), []);
    assert.match(check(OK.replace("ci:\n", "ci:\n  fix: {bogus: 1}\n")).join(), /bogus: unknown key/);
    assert.notDeepEqual(check(OK.replace("ci:\n", "ci:\n  fix: {max_rounds: x}\n")), []);
  });
});

describe("I23 deferred keys are rejected", () => {
  const cases = {
    "plan.auto_if": "plan: {auto_if: x}\n", "retention_days": "retention_days: 30\n", "ci.forbid_per_issue_steps": "ci: {forbid_per_issue_steps: true}\n",
    "couplings[].refine": "couplings:\n  - {paths: [a], affects: [api], refine: x}\n", "ci.provider: command": "ci: {provider: command}\n", "risk.weights": "risk: {weights: {a: 1}}\n",
  };
  for (const [name, extra] of Object.entries(cases)) it(name, () => {
    const out = check(`schema: 1\nunits:\n  api: {paths: [a]}\n${extra}`);
    assert.ok(out.some((l) => l.startsWith(name) && /deferred/.test(l)), `${name}: ${out.join(" | ")}`);
  });
});

describe("readPolicy (I13)", () => {
  it("reads origin/<default>:.forge/release.yaml via git show only; a head-modified worktree copy has no effect", () => {
    const cwd = tmpDir("relcfg-");
    mkdirSync(join(cwd, ".forge"));
    writeFileSync(join(cwd, POLICY_PATH), "schema: 1\nplan: {approval: auto}\n"); // PR head weakens the gate
    const calls = [];
    const r = readPolicy({ io: ioFor({ "origin/main:.forge/release.yaml": INIT_PROFILE }, calls), defaultBranch: "main", cwd });
    assert.deepEqual(calls, [["show", "origin/main:.forge/release.yaml"]]);
    assert.equal(r.source, "file");
    assert.equal(r.policy.plan.approval, "wait");
    assert.match(r.sha, /^[0-9a-f]{64}$/);
  });
  it("an invalid committed file yields findings and no policy", () => {
    const r = readPolicy({ io: ioFor({ "origin/main:.forge/release.yaml": "schema: 1\nx: 1\n" }), defaultBranch: "main" });
    assert.equal(r.policy, null); assert.match(r.findings.join(), /x: unknown key/);
  });
  it("absent file falls back to the flat forge.yaml release.* keys", () => {
    const cwd = tmpDir("relcfg-");
    writeFileSync(join(cwd, "forge.yaml"), "release:\n  auto_merge: true\n  publish_workflow: p.yml\n");
    const r = readPolicy({ io: ioFor({}), defaultBranch: "main", cwd });
    assert.equal(r.source, "forge.yaml"); assert.equal(r.flat.autoMerge, true); assert.equal(r.flat.publishWorkflow, "p.yml");
  });
});

describe("CLI", () => {
  it("check-config exits 1 on findings, 0 when valid or absent", async () => {
    const cwd = tmpDir("relcfg-");
    const run = (files) => { const io = ioFor(files); return releaseFromCli(["check-config"], { io, cwd }).then((c) => [c, io.printed.join("\n")]); };
    assert.equal((await run({ "origin/main:.forge/release.yaml": OK }))[0], 0);
    const bad = await run({ "origin/main:.forge/release.yaml": OK + "zzz: 1\n" });
    assert.equal(bad[0], 1); assert.match(bad[1], /zzz: unknown key/);
    assert.equal((await run({}))[0], 0);
  });
  it("init writes the 7.4 profile and nothing else, and never overwrites", async () => {
    const cwd = tmpDir("relcfg-");
    const io = ioFor({});
    assert.equal(await releaseFromCli(["init"], { io, cwd }), 0);
    assert.equal(readFileSync(join(cwd, POLICY_PATH), "utf8"), INIT_PROFILE);
    assert.deepEqual(readdirSync(cwd), [".forge"]); assert.deepEqual(readdirSync(join(cwd, ".forge")), ["release.yaml"]);
    assert.deepEqual(check(INIT_PROFILE), []);
    assert.equal(initFromCli([], { io, cwd }), 1);
    assert.equal(existsSync(join(cwd, "forge.yaml")), false);
  });

  it("accepts the flake and quarantine policy keys (#5568)", () => {
    assert.deepEqual(check(`${OK}  flake: {quarantine_after: 3, window_days: 14}\nquarantine: {days: 14, max: 15}\n`.replace("ci:\n  tiers: {T3: {jobs: [e2e]}}\n  flake", "ci:\n  tiers: {T3: {jobs: [e2e]}}\n  flake")), []);
    assert.notDeepEqual(check(`${OK}quarantine: {max: x}\n`), []);
  });
  it("accepts the verification layer keys and rejects a bad result kind (#5562)", () => {
    assert.deepEqual(check(`${OK}verify:\n  workflow: verify.yml\n  close_requires: verified\n  results: [{workflow: smoke.yml, kind: smoke}]\n  flags: [{flag: F, off_command: x}]\n`), []);
    assert.notDeepEqual(check(`${OK}verify:\n  results: [{workflow: s.yml, kind: nope}]\n`), []);
  });
});

describe("gates catalogue and policy (#5583)", () => {
  const GATE = `schema: 1\ngates:\n  - {id: g1, protects_against: "#1", where: deploy, determinism: high, pre_merge_artifact: f.json, version: v1, mode: block, owner: me, review_by: 2027-01-01}\n`;
  const gio = (files) => ({ printed: [], print(l) { this.printed.push(l); }, git(a) { const t = files[a[1].split(":").slice(1).join(":")]; if (t === undefined) throw new Error("missing"); return t; } });
  it("accepts the gates policy keys and rejects a wrong type", () => {
    assert.deepEqual(check(OK + "gates: {demote_fb_rate: 5, demote_window: 20, safety: [a]}\n"), []);
    assert.match(check(OK + "gates: {demote_window: 2.5}\n").join(), /demote_window/);
    assert.deepEqual(check(OK + "gates: {paths: [scripts/deploy/**], workflow_steps: [Smoke]}\n"), []); // #5584
    assert.match(check(OK + "gates: {workflow_steps: Smoke}\n").join(), /workflow_steps/);
    assert.match(check(OK + "gates: {bogus: 1}\n").join(), /bogus/);
  });
  it("check-config reports catalogue errors, passes a valid one, ignores an absent one", () => {
    const bad = gio({ ".forge/gates.yaml": GATE.replace("mode: block", "mode: nope"), [POLICY_PATH]: OK });
    assert.equal(checkConfigFromCli([], { io: bad }), 1);
    assert.match(bad.printed.join("\n"), /gates\.yaml: gates\[0\]\.mode/);
    const good = gio({ ".forge/gates.yaml": GATE, [POLICY_PATH]: OK });
    assert.equal(checkConfigFromCli([], { io: good }), 0);
    const none = gio({ [POLICY_PATH]: OK });
    assert.equal(checkConfigFromCli([], { io: none }), 0);
    assert.doesNotMatch(none.printed.join("\n"), /gates/);
  });
});

describe("rollback and events keys (#5563)", () => {
  const rb = "rollback:\n  ladder: [flag, unit, full, stop]\n  triggers: [smoke, sli]\n  refuse_across: [destructive_migration]\n  open_revert_pr: true\n  flags: [{flag: f1, kill_command: ./kill}]\n  unit_workflow: svc.yml\n  full_workflow: rb.yml\n  result_command: ./res\nevents: {webhook_url: https://x.test/h}\n";
  it("accepts the typed ladder keys", () => assert.deepEqual(check(`${OK}${rb}`), []));
  it("rejects an unknown rung, trigger and key", () => {
    assert.match(check(`${OK}rollback: {ladder: [nuke]}\n`).join("\n"), /ladder\[0\].*not one of/);
    assert.match(check(`${OK}rollback: {triggers: [moon]}\n`).join("\n"), /triggers\[0\]/);
    assert.match(check(`${OK}rollback: {sql: x}\n`).join("\n"), /rollback\.sql: unknown key/);
  });
});

describe("check-config --coverage and contracts[].regenerate (#5570, Q9)", () => {
  const POL = `${OK.replace("api: {paths", "api: {dockerfile: services/api/Dockerfile, paths")}`;
  const mkio = (docker) => ({ printed: [], print(l) { this.printed.push(l); }, git(a) { const k = a[1].split(":").slice(1).join(":"); if (k === POLICY_PATH) return POL; if (k === "services/api/Dockerfile") return docker; throw new Error("missing"); } });
  it("parses COPY/ADD sources, skipping --from copies and urls", () => {
    assert.deepEqual(dockerfileSources("FROM x\nCOPY --from=build /out /app\nCOPY a/ b.txt /app/\nADD https://x/y /z\nCOPY . /all\n"), ["a/", "b.txt"]);
  });
  it("fails on a Dockerfile copying an unmapped path and passes once it is mapped", () => {
    const bad = mkio("FROM x\nCOPY services/api /app\nCOPY libs/secret /app/libs\n");
    assert.equal(checkConfigFromCli(["--coverage"], { io: bad }), 1);
    assert.match(bad.printed.join("\n"), /copies libs\/secret/);
    assert.deepEqual(dockerfileCoverage(parsePolicy(POL).policy, "COPY services/api /app\nCOPY shared /s\n"), []);
    const good = mkio("FROM x\nCOPY services/api /app\nCOPY shared /s\n");
    assert.equal(checkConfigFromCli(["--coverage"], { io: good }), 0);
  });
  it("without --coverage the Dockerfile is not read", () => assert.equal(checkConfigFromCli([], { io: mkio("COPY nowhere /x\n") }), 0));
  it("accepts an optional contracts[].regenerate and rejects a wrong type", () => {
    const c = (r) => validatePolicy(parsePolicy(`${OK}contracts:\n  - {producer: api, consumers: [web], paths: ["c/**"], regenerate: ${r}}\n`).policy);
    assert.deepEqual(c('"make gen"'), []);
    assert.match(c("[1]").join(), /regenerate/);
  });
});

describe("features.flag_policy (#5571)", () => {
  it("accepts require|warn|off and rejects anything else", () => {
    for (const v of ["require", "warn", "off"]) assert.deepEqual(check(OK + `features: {flag_policy: ${v}}\n`), [], v);
    assert.match(check(OK + "features: {flag_policy: maybe}\n").join(), /flag_policy/);
  });
});
