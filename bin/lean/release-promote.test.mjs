// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5711: build once, promote. Pure functions, the off switch, the check-run register and the CLI over a fake io.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePromoteConfig, configHash, checkEvidence, buildAttestation, canPromote, decide, formatDecision, readEvidence, promoteDecision,
  agreeOf, agreement, serviceGlobs, cacheMounts, buildxArgs, digestFromMetadata, planImages, formatPlan, promoteFromCli,
  EVIDENCE_CHECK, DECISION_CHECK, ATTEST_SCHEMA, DECISION_SCHEMA, SHADOW_EXIT, PROMOTE_KEYS,
} from "./release-promote.mjs";
import { evidenceSkips, validateCatalogue } from "./release-gates.mjs";
import { releaseFromCli } from "./release.mjs";
import { validateForgeYaml, CLOSED } from "../config-schema.mjs";
import { tmpDir } from "../tests/_tmp.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const h = (c, n = 40) => c.repeat(n);
const A = h("a"), M = h("b"), T = h("1"), T2 = h("2"), P0 = h("c");
const dg = (c) => `sha256:${h(c, 64)}`;
// Three ecosystems: a Node web app, a Python API (uv) and a Go worker.
const YAML = `project:
  owner: acme
deploy:
  promote:
    enabled: true
    required_checks: [unit, build]
    cache_ref: registry.example/acme/buildcache
    rebuild_all: ["docker/base/**"]
    services:
      web:
        image: registry.example/acme/web
        context: web
        cache_paths: ["/app/.next/cache", "/root/.npm"]
      api:
        image: registry.example/acme/api
        context: services/api
        dockerfile: services/api/Dockerfile.prod
        paths: ["libs/shared/**", "uv.lock"]
        cache_paths: ["/root/.cache/uv"]
      worker:
        image: registry.example/acme/worker
        context: .
        dockerfile: cmd/worker/Dockerfile
        paths: ["cmd/worker/**", "internal/**", "go.sum"]
        cache_paths: ["/root/.cache/go-build"]
`;
const ENFORCE = YAML.replace("enabled: true", "enabled: true\n    shadow: false");
const cfg = parsePromoteConfig(YAML), cfgE = parsePromoteConfig(ENFORCE);
const IMAGES = { web: dg("1"), api: dg("2"), worker: dg("3") };
const run = (name, conclusion = "success", head = A, id = 1) => ({ name, conclusion, head, id, details_url: `https://example.invalid/acme/app/actions/runs/${900 + id}/job/5` });
const CHECKS = [run("unit", "success", A, 1), run("build", "success", A, 2), run("lint", "failure", A, 3)];
const att = (over = {}) => ({ ...buildAttestation({ commit: A, tree: T, checks: CHECKS, images: IMAGES, cfg, now: 0 }).attestation, ...over });
const target = (over = {}) => ({ commit: M, tree: T, digests: IMAGES, required: cfg.requiredChecks, configHash: configHash(cfg), ...over });

describe("deploy.promote config", () => {
  it("is off when absent, false or unreadable, and off reads no service", () => {
    for (const raw of ["", "project:\n  owner: acme\n", "deploy:\n  workflow: deploy.yml\n", YAML.replace("enabled: true", "enabled: false"), YAML.replace("enabled: true", 'enabled: "yes"')]) {
      const c = parsePromoteConfig(raw);
      assert.deepEqual([c.enabled, c.mode, Object.keys(c.services), c.findings], [false, "off", [], []]);
    }
    assert.equal(parsePromoteConfig("a: [1\n").mode, "off");
  });
  it("defaults to shadow once enabled; shadow: false is enforce", () => {
    assert.deepEqual([cfg.mode, cfg.shadow, cfgE.mode], ["shadow", true, "enforce"]);
    assert.deepEqual(cfg.findings, []);
    assert.deepEqual(cfg.requiredChecks, ["unit", "build"]);
    assert.equal(cfg.evidenceApp, "github-actions");
  });
  it("normalizes services: Dockerfile under the context by default", () => {
    assert.equal(cfg.services.web.dockerfile, "web/Dockerfile");
    assert.equal(cfg.services.api.dockerfile, "services/api/Dockerfile.prod");
    assert.deepEqual(cfg.services.worker.paths, ["cmd/worker/**", "internal/**", "go.sum"]);
  });
  it("falls back to gate.required_checks, then the policy list, and to policy units for services", () => {
    const bare = "gate:\n  required_checks: [ci]\ndeploy:\n  promote:\n    enabled: true\n";
    assert.deepEqual(parsePromoteConfig(bare).requiredChecks, ["ci"]);
    const policy = { ci: { required_checks: ["tests"] }, units: { svc: { image: "registry.example/acme/svc", paths: ["svc/**"], dockerfile: "svc/Dockerfile" }, docs: { paths: ["docs/**"] } } };
    const c = parsePromoteConfig("deploy:\n  promote:\n    enabled: true\n", { policy });
    assert.deepEqual(c.requiredChecks, ["tests"]);
    assert.deepEqual(Object.keys(c.services), ["svc"]);
    assert.equal(c.services.svc.dockerfile, "svc/Dockerfile");
  });
  it("reports findings: no required checks, unknown keys, bad refs, bad mode", () => {
    const c = parsePromoteConfig("deploy:\n  promote:\n    enabled: true\n    shadwo: false\n    cache_mode: all\n    cache_ref: \"reg.example/x,mode=max\"\n    services:\n      web:\n        contxt: web\n");
    assert.deepEqual(c.findings.sort(), ["deploy.promote.cache_mode: expected min or max", 'deploy.promote.cache_ref: "reg.example/x,mode=max" is not a registry reference', "deploy.promote.required_checks: no required checks (set it, or gate.required_checks)", "deploy.promote.services.web.contxt: unknown key", "deploy.promote.services.web.image: required", "deploy.promote.shadwo: unknown key"]);
    assert.equal(c.mode, "shadow", "a typo of shadow never turns enforce on");
  });
  it("the schema check knows the block and flags a typo", () => {
    assert.deepEqual(CLOSED["deploy.promote"], PROMOTE_KEYS);
    assert.deepEqual(validateForgeYaml(YAML), []);
    assert.deepEqual(validateForgeYaml(YAML.replace("cache_ref:", "cache_reff:")).map((f) => f.key), ["deploy.promote.cache_reff"]);
    assert.deepEqual(validateForgeYaml(YAML.replace("enabled: true", "enabled: maybe")).map((f) => f.code), ["wrong-type"]);
  });
  it("the config hash moves with required checks and service inputs, not with shadow or key order", () => {
    assert.equal(configHash(cfg), configHash(cfgE));
    assert.notEqual(configHash(cfg), configHash({ ...cfg, requiredChecks: ["unit"] }));
    assert.notEqual(configHash(cfg), configHash(parsePromoteConfig(YAML.replace("context: web", "context: web2"))));
    assert.equal(configHash(cfg), configHash({ ...cfg, requiredChecks: ["build", "unit"] }));
  });
});

describe("attestation", () => {
  it("records commit, tree, digests, checks with run ids and the config hash", () => {
    assert.deepEqual(att(), { schema: ATTEST_SCHEMA, commit: A, tree: T, images: IMAGES, checks: [{ name: "unit", conclusion: "success", id: 1, run_id: 901 }, { name: "build", conclusion: "success", id: 2, run_id: 902 }], config_hash: configHash(cfg), at: "1970-01-01T00:00:00.000Z" });
  });
  it("is refused unless every required check is success on the exact commit", () => {
    const refused = (checks) => buildAttestation({ commit: A, tree: T, checks, images: IMAGES, cfg }).refused;
    assert.deepEqual(refused([run("unit")]), [`build: missing on ${A}`]);
    assert.deepEqual(refused([run("unit"), run("build", "failure")]), ["build: failure, not success"]);
    assert.deepEqual(refused([run("unit"), run("build", null)]), ["build: unfinished, not success"]);
    assert.deepEqual(refused([run("unit"), run("build", "skipped")]), ["build: skipped, not success"]);
    assert.deepEqual(refused([run("unit"), run("build", "success", M)]), [`build: missing on ${A}`]);
    assert.deepEqual(refused([run("unit"), run("build", "success", A, 2), run("build", "failure", A, 9)]), ["build: failure, not success"]);
    assert.deepEqual(refused(null), ["unreadable input: checks"]);
  });
  it("is refused for a missing or malformed digest of a configured service, or a config finding", () => {
    const r = buildAttestation({ commit: A, tree: T, checks: CHECKS, images: { web: dg("1"), api: "latest" }, cfg }).refused;
    assert.deepEqual(r, ["image api: not a sha256 digest", "image worker: no digest"]);
    assert.match(buildAttestation({ commit: A, tree: T, checks: CHECKS, images: IMAGES, cfg: { ...cfg, findings: ["deploy.promote.x: unknown key"] } }).refused.join(), /unknown key/);
    assert.deepEqual(buildAttestation({ commit: "", tree: "", checks: CHECKS, images: IMAGES, cfg }).refused.slice(0, 2), ["no commit sha", "no tree sha"]);
  });
  it("checkEvidence fails closed without required checks", () => {
    assert.equal(checkEvidence(CHECKS, [], A).ok, false);
    assert.equal(checkEvidence(CHECKS, undefined, A).ok, false);
  });
});

describe("canPromote", () => {
  it("accepts the attested commit and a merge commit with the same tree", () => {
    assert.deepEqual(canPromote(att(), target({ commit: A })), { ok: true, reasons: [], match: "commit" });
    assert.deepEqual(canPromote(att(), target()), { ok: true, reasons: [], match: "tree" });
    assert.equal(canPromote(att(), target({ checks: CHECKS })).ok, true);
  });
  const no = (ev, tg, re) => { const v = canPromote(ev, tg); assert.equal(v.ok, false); assert.match(v.reasons.join("; "), re); };
  it("refuses without evidence or with unreadable input", () => {
    no(null, target(), /no attestation/);
    no({ schema: "other" }, target(), /no attestation/);
    no(att(), null, /unreadable target/);
    no(att(), target({ tree: undefined }), /unreadable target/);
    no(att({ tree: null }), target(), /unreadable attestation/);
  });
  it("refuses a different tree", () => no(att(), target({ tree: T2 }), /is not the attested tree/));
  it("refuses a required check missing from, or not success in, the attestation", () => {
    no(att(), target({ required: ["unit", "build", "migrations"] }), /migrations: not in the attestation/);
    no(att({ checks: [{ name: "unit", conclusion: "success" }, { name: "build", conclusion: "failure" }] }), target(), /build: attested as failure/);
    no(att(), target({ required: [] }), /no required checks configured/);
  });
  it("refuses when the checks no longer pass on the attested commit, or cannot be read", () => {
    no(att(), target({ checks: [run("unit"), run("build", "failure")] }), /now build: failure/);
    no(att(), target({ checks: [run("unit")] }), /now build: missing/);
    no(att(), target({ checks: null }), /now unreadable input: checks/);
  });
  it("refuses a digest mismatch, a service that was never attested, and unknown target digests", () => {
    no(att(), target({ digests: { ...IMAGES, web: dg("9") } }), /image web: .* is not the attested/);
    no(att(), target({ digests: { ...IMAGES, cron: dg("4") } }), /image cron: .*\(none\)/);
    no(att(), target({ digests: { web: "web:latest" } }), /not a sha256 digest/);
    no(att(), target({ digests: undefined }), /target digests unknown/);
    assert.equal(canPromote(att(), target({ digests: { web: IMAGES.web } })).ok, true, "a deploy of a subset of the attested images");
  });
  it("refuses a config-hash mismatch", () => {
    no(att(), target({ configHash: h("f", 64) }), /config hash differs/);
    no(att(), target({ configHash: undefined }), /config hash differs/);
  });
  it("a repo without images promotes on tree and checks alone", () => {
    const c = parsePromoteConfig("deploy:\n  promote:\n    enabled: true\n    required_checks: [unit]\n");
    const a = buildAttestation({ commit: A, tree: T, checks: CHECKS, images: {}, cfg: c }).attestation;
    assert.equal(canPromote(a, { commit: M, tree: T, required: ["unit"], configHash: configHash(c) }).ok, true);
  });
});

describe("decide", () => {
  it("off never skips and gives no skips", () => {
    const d = decide(parsePromoteConfig(""), att(), target());
    assert.deepEqual([d.mode, d.would_skip, d.skip_pre_gate, d.skips], ["off", false, false, []]);
  });
  it("shadow records would_skip and never skips; enforce skips", () => {
    const s = decide(cfg, att(), target()), e = decide(cfgE, att(), target());
    assert.deepEqual([s.mode, s.would_skip, s.skip_pre_gate], ["shadow", true, false]);
    assert.deepEqual([e.mode, e.would_skip, e.skip_pre_gate, e.match, e.evidence_commit], ["enforce", true, true, "tree", A]);
    assert.deepEqual(e.skips.map((x) => x.what), ["check:unit", "check:build", "image:web", "image:api", "image:worker"]);
    assert.match(e.skips[0].why, /run 901/);
  });
  it("any mismatch or config finding means the full pre-gate, in enforce too", () => {
    const d = decide(cfgE, att(), target({ tree: T2 }));
    assert.deepEqual([d.would_skip, d.skip_pre_gate, d.skips], [false, false, []]);
    const f = decide({ ...cfgE, findings: ["deploy.promote.x: unknown key"] }, att(), target());
    assert.deepEqual([f.would_skip, f.skip_pre_gate], [false, false]);
    assert.equal(decide(cfgE, null, target()).skip_pre_gate, false);
  });
  it("formats the explanation", () => {
    assert.match(formatDecision(decide(cfg, att(), target()))[0], /shadow: the pre-gate WOULD be skipped \(it still runs\)/);
    assert.match(formatDecision(decide(cfgE, att(), target({ commit: A })))[0], /the pre-gate is skipped .* \(the attested commit\)/);
    const lines = formatDecision(decide(cfgE, att(), target({ tree: T2 })));
    assert.match(lines[0], /the full pre-gate runs/);
    assert.match(lines[1], /no: tree/);
    assert.match(formatDecision({ mode: "off" })[0], /off/);
  });
});

describe("gate catalogue: CI evidence", () => {
  const G = { id: "tests-rerun", protects_against: "#1", where: "deploy.yml", determinism: "high", pre_merge_artifact: "ci", version: "v1", mode: "block", owner: "ops", review_by: "2027-01-01" };
  const cat = { schema: 1, gates: [{ ...G, evidence_check: "unit" }, { ...G, id: "backup-freshness", evidence_check: "unit" }, { ...G, id: "migration:rehearsal", evidence_check: "build" }, { ...G, id: "smoke" }, { ...G, id: "contract", evidence_check: "contract-tests" }] };
  it("evidence_check is a valid catalogue key", () => assert.deepEqual(validateCatalogue(cat), []));
  it("skips only a non-safety gate whose check is attested, and only when the evidence was accepted", () => {
    const r = evidenceSkips(cat, att(), { ok: true });
    assert.deepEqual(r.map((g) => [g.gate, g.skip]), [["tests-rerun", true], ["backup-freshness", false], ["migration:rehearsal", false], ["contract", false]]);
    assert.match(r[1].why, /safety gate/);
    assert.match(r[3].why, /contract-tests is not in the attestation/);
    assert.deepEqual(r[0].record, { gate: "tests-rerun", outcome: "skip", class: "unknown", minutes: 0, evidence: `promote: unit passed on ${A.slice(0, 12)}` });
    assert.deepEqual(evidenceSkips(cat, att(), { ok: false }).filter((g) => g.skip), []);
    assert.deepEqual(evidenceSkips(cat, att()).filter((g) => g.skip), [], "not accepted by default");
    assert.deepEqual(evidenceSkips(null, att(), { ok: true }), []);
  });
  it("decide lists the gates", () => {
    assert.deepEqual(decide(cfgE, att(), target(), { catalogue: cat }).gates.filter((g) => g.skip).map((g) => g.gate), ["tests-rerun"]);
    assert.deepEqual(decide(cfgE, att(), target({ tree: T2 }), { catalogue: cat }).gates.filter((g) => g.skip), []);
  });
});

describe("shadow agreement", () => {
  const rec = (would_skip, observed, minutes = 20) => ({ schema: DECISION_SCHEMA, would_skip, observed, minutes });
  it("a would-skip agrees with a passing pre-gate and disagrees with a failing one; no claim otherwise", () => {
    assert.deepEqual([agreeOf(true, "pass"), agreeOf(true, "fail"), agreeOf(false, "pass"), agreeOf(false, "fail"), agreeOf(true, null)], [true, false, null, null, null]);
  });
  it("counts and applies the exit criterion", () => {
    const some = [rec(true, "pass"), rec(true, "pass", 23.7), rec(true, "fail"), rec(false, "fail"), rec(true, null), { schema: "other" }];
    assert.deepEqual(agreement(some), { decisions: 5, would_skip: 4, observed: 3, agree: 2, disagree: 1, minutes_saved: 43.7, exit_met: false });
    assert.equal(agreement(Array.from({ length: SHADOW_EXIT.observed }, () => rec(true, "pass"))).exit_met, true);
    assert.equal(agreement([...Array.from({ length: 20 }, () => rec(true, "pass")), rec(true, "fail")]).exit_met, false);
    assert.equal(agreement(Array.from({ length: SHADOW_EXIT.observed - 1 }, () => rec(true, "pass"))).exit_met, false);
    assert.equal(agreement(null).decisions, 0);
  });
});

describe("image build plan", () => {
  const plan = (changed, previous = IMAGES, c = cfg) => planImages({ cfg: c, changed, previous, sha: A });
  it("globs: paths, the context and the Dockerfile; a root context without paths is everything", () => {
    assert.deepEqual(serviceGlobs(cfg.services.web), ["web/**", "web/Dockerfile"]);
    assert.deepEqual(serviceGlobs(cfg.services.worker), ["cmd/worker/**", "internal/**", "go.sum", "cmd/worker/Dockerfile"]);
    assert.deepEqual(serviceGlobs({ context: ".", dockerfile: "Dockerfile", paths: [] }), ["**", "Dockerfile"]);
  });
  it("an unchanged service reuses its previous digest; a changed one builds", () => {
    const p = plan(["web/src/app/page.tsx", "web/package-lock.json", "README.md"]);
    assert.deepEqual([p.build, p.reuse], [["web"], ["api", "worker"]]);
    assert.deepEqual(p.images[1], { service: "api", image: "registry.example/acme/api", build: false, reason: "no changed path in its build inputs", digest: IMAGES.api, cache_mounts: [{ target: "/root/.cache/uv", id: "/root/.cache/uv", declared: false }] });
    assert.equal(p.images[0].reason, "changed: web/src/app/page.tsx (+1)");
  });
  it("each ecosystem's lockfile and shared paths rebuild only their service", () => {
    assert.deepEqual(plan(["uv.lock"]).build, ["api"]);
    assert.deepEqual(plan(["libs/shared/models.py"]).build, ["api"]);
    assert.deepEqual(plan(["go.sum", "internal/queue/q.go"]).build, ["worker"]);
    assert.deepEqual(plan(["services/api/Dockerfile.prod"]).build, ["api"]);
    assert.deepEqual(plan(["docs/x.md"]).build, []);
    assert.deepEqual(plan([]).build, []);
  });
  it("builds when the changed paths are unknown, there is no (valid) previous digest, or a rebuild_all path changed", () => {
    assert.deepEqual(plan(null).build, ["web", "api", "worker"]);
    assert.equal(plan(null).images[0].reason, "changed paths unknown");
    assert.deepEqual(plan(["docs/x.md"], {}).build, ["web", "api", "worker"]);
    assert.deepEqual(plan(["docs/x.md"], { ...IMAGES, api: "api:latest" }).build, ["api"]);
    const p = plan(["docker/base/Dockerfile"]);
    assert.deepEqual(p.build, ["web", "api", "worker"]);
    assert.equal(p.images[2].reason, "docker/base/Dockerfile rebuilds every image");
  });
  it("emits buildx args with a registry layer cache per service", () => {
    assert.deepEqual(buildxArgs("web", cfg.services.web, { sha: A, cfg }), [
      "buildx", "build", "--file", "web/Dockerfile", "--tag", `registry.example/acme/web:${A}`,
      "--cache-from", "type=registry,ref=registry.example/acme/buildcache:web", "--cache-to", "type=registry,ref=registry.example/acme/buildcache:web,mode=max",
      "--metadata-file", ".forge/build/web.json", "--push", "web",
    ]);
    const c2 = parsePromoteConfig(YAML.replace("cache_ref: registry.example/acme/buildcache", "builder: ci-builder\n    cache_mode: min").replace("context: web\n", "context: web\n        cache_ref: registry.example/acme/web:cache\n"));
    assert.deepEqual(c2.findings, []);
    const a = buildxArgs("web", c2.services.web, { sha: A, cfg: c2 });
    assert.deepEqual(a.slice(2, 4), ["--builder", "ci-builder"]);
    assert.ok(a.includes("type=registry,ref=registry.example/acme/web:cache,mode=min"));
    assert.equal(buildxArgs("api", c2.services.api, { sha: A, cfg: c2 }).includes("--cache-from"), false, "no cache ref: no cache flags");
    assert.match(plan(["web/a"]).images[0].command, /^docker buildx build --file web\/Dockerfile /);
  });
  it("cache mounts come from the Dockerfile; an undeclared cache path is a warning", () => {
    const df = "FROM node:22\nRUN --mount=type=cache,id=next,target=/app/.next/cache \\\n    --mount=type=cache,target=/root/.npm npm run build\nRUN --mount=type=secret,id=tok,target=/x true\n";
    assert.deepEqual(cacheMounts(df, ["/app/.next/cache", "/root/.npm/", "/x", "/root/.cache/uv"]), [
      { target: "/app/.next/cache", id: "next", declared: true }, { target: "/root/.npm", id: "/root/.npm", declared: true },
      { target: "/x", id: "/x", declared: false }, { target: "/root/.cache/uv", id: "/root/.cache/uv", declared: false },
    ]);
    const p = planImages({ cfg, changed: ["web/a"], previous: IMAGES, sha: A, dockerfiles: { web: df } });
    const text = formatPlan(p).join("\n");
    assert.match(text, /build web: changed: web\/a/);
    assert.match(text, /cache mount next -> \/app\/\.next\/cache/);
    assert.match(text, /reuse api: sha256:2+ /);
    assert.match(text, /warning: \/root\/\.cache\/uv is in cache_paths but the Dockerfile has no RUN --mount=type=cache/);
    assert.match(formatPlan(planImages({ cfg: parsePromoteConfig(""), changed: [], sha: A }))[0], /no services/);
  });
  it("reads a digest from buildx metadata", () => {
    assert.equal(digestFromMetadata(JSON.stringify({ "containerimage.digest": dg("7") })), dg("7"));
    assert.equal(digestFromMetadata("{}"), null);
    assert.equal(digestFromMetadata("nope"), null);
  });
});

/** A fake GitHub: commits, check runs (evidence and decisions are check runs too), pulls. Records every call. */
function fakeIo({ commits = {}, checks = {}, pulls = {}, app = "github-actions", denyPost = false } = {}) {
  const calls = [], printed = [], runs = [];
  let nextId = 100;
  const io = {
    calls, printed, runs, print: (l) => printed.push(l), now: () => 0,
    git: (args) => { calls.push(`git ${args.join(" ")}`); if (args[0] === "rev-parse") return `${args[1] === "HEAD" ? M : args[1]}\n`; if (args[0] === "diff") return "web/a.ts\n"; throw new Error("no such object"); },
    gh: async (args) => {
      calls.push(`gh ${args.join(" ")}`);
      if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "acme/app" });
      const m = /commits\/([0-9a-f]+)\/check-runs/.exec(args[2] ?? "");
      if (m) return (checks[m[1]] ?? []).map((c) => JSON.stringify({ name: c.name, conclusion: c.conclusion, head: c.head, id: c.id, details_url: c.details_url, app: "github-actions" })).join("\n");
      throw new Error(`unexpected gh ${args.join(" ")}`);
    },
    api: async (method, path, body) => {
      calls.push(`${method} ${path}`);
      let m;
      if (method === "POST" && /\/check-runs$/.test(path)) {
        if (denyPost) throw Object.assign(new Error("HTTP 403"), { status: 403 });
        runs.push({ id: nextId++, name: body.name, head_sha: body.head_sha, app: { slug: app }, output: { text: body.output.text }, conclusion: body.conclusion });
        return { id: nextId - 1 };
      }
      if ((m = /git\/commits\/([0-9a-f]+)$/.exec(path))) { const c = commits[m[1]]; if (!c) throw Object.assign(new Error("HTTP 404"), { status: 404 }); return { sha: m[1], tree: { sha: c.tree }, parents: (c.parents ?? []).map((sha) => ({ sha })) }; }
      if ((m = /commits\/([0-9a-f]+)\/check-runs\?check_name=([^&]+)/.exec(path))) return { check_runs: runs.filter((r) => r.head_sha === m[1] && r.name === decodeURIComponent(m[2])) };
      if ((m = /commits\/([0-9a-f]+)\/pulls$/.exec(path))) return pulls[m[1]] ?? [];
      if (/\/commits\?sha=/.test(path)) return Object.keys(commits).map((sha) => ({ sha }));
      throw new Error(`unexpected api ${method} ${path}`);
    },
  };
  return io;
}
const WORLD = { commits: { [A]: { tree: T, parents: [P0] }, [M]: { tree: T, parents: [P0, A] } }, checks: { [A]: CHECKS } };
const cli = (argv, io, raw = YAML, extra = {}) => promoteFromCli(argv, { io, raw, env: {}, readFile: () => { throw new Error("no file"); }, ...extra });
const DIG = JSON.stringify(IMAGES);

describe("register and CLI", () => {
  it("off: one line, exit 0, no read and no write", async () => {
    const io = fakeIo(WORLD);
    assert.equal(await cli(["--gate", "--sha", M], io, "project:\n  owner: acme\n"), 0);
    assert.deepEqual(io.calls, []);
    assert.match(io.printed.join("\n"), /release promote: off/);
    const io2 = fakeIo(WORLD);
    await cli(["--check", "--json"], io2, YAML.replace("enabled: true", "enabled: false"));
    assert.deepEqual([io2.calls, JSON.parse(io2.printed[0]).skip_pre_gate], [[], false]);
  });
  it("release promote <gate> --fixture is still the control verb; the promote flags route here", async () => {
    const dir = tmpDir("promote-cli-");
    writeFileSync(join(dir, "forge.yaml"), "project:\n  owner: acme\n");
    const io = fakeIo(WORLD);
    assert.equal(await releaseFromCli(["promote", "--check"], { io, cwd: dir, env: {} }), 0);
    assert.deepEqual(io.calls, [], "off reads nothing, not even the policy");
    assert.match(io.printed[0], /release promote: off/);
  });
  it("--attest writes the evidence check run on the commit; --check then explains; --check writes nothing", async () => {
    const io = fakeIo(WORLD);
    assert.equal(await cli(["--attest", "--sha", A, "--digests", DIG], io), 0);
    assert.deepEqual(io.runs.map((r) => [r.name, r.head_sha, r.conclusion]), [[EVIDENCE_CHECK, A, "neutral"]]);
    assert.deepEqual(JSON.parse(io.runs[0].output.text).tree, T);
    const before = io.runs.length;
    assert.equal(await cli(["--check", "--sha", M, "--digests", DIG], io), 0);
    assert.equal(io.runs.length, before);
    assert.equal(io.calls.filter((c) => c.startsWith("POST")).length, 1);
    assert.match(io.printed.join("\n"), /shadow: the pre-gate WOULD be skipped .*same tree as attested aaaaaaaaaaaa/);
  });
  it("--attest refuses (no write, exit 1) when a required check failed; --dry-run writes nothing", async () => {
    const io = fakeIo({ ...WORLD, checks: { [A]: [run("unit"), run("build", "failure")] } });
    assert.equal(await cli(["--attest", "--sha", A, "--digests", DIG], io), 1);
    assert.deepEqual(io.runs, []);
    assert.match(io.printed.join("\n"), /not attested: build: failure/);
    const io2 = fakeIo(WORLD);
    assert.equal(await cli(["--attest", "--sha", A, "--digests", DIG, "--dry-run"], io2), 0);
    assert.deepEqual(io2.runs, []);
  });
  it("evidence is found on a parent (merge commit) or a merged pull request head (squash), never on an unrelated commit", async () => {
    const io = fakeIo({ ...WORLD, commits: { ...WORLD.commits, [h("d")]: { tree: T, parents: [P0] } }, pulls: { [h("d")]: [{ head: { sha: A } }] } });
    await cli(["--attest", "--sha", A, "--digests", DIG], io);
    assert.equal((await readEvidence({ io, repo: "acme/app", target: { commit: M, parents: [P0, A] } })).commit, A);
    assert.equal((await readEvidence({ io, repo: "acme/app", target: { commit: h("d"), parents: [P0] } })).commit, A);
    assert.equal(await readEvidence({ io, repo: "acme/app", target: { commit: h("e"), parents: [P0] } }), null);
  });
  it("evidence from another app, or a document naming another commit, is ignored", async () => {
    const other = fakeIo({ ...WORLD, app: "some-other-app" });
    await cli(["--attest", "--sha", A, "--digests", DIG], other);
    assert.equal(await readEvidence({ io: other, repo: "acme/app", target: { commit: A } }), null);
    const io = fakeIo(WORLD);
    io.runs.push({ id: 1, name: EVIDENCE_CHECK, head_sha: M, app: { slug: "github-actions" }, output: { text: JSON.stringify(att()) } }); // A's attestation copied onto M
    assert.equal(await readEvidence({ io, repo: "acme/app", target: { commit: M, parents: [] } }), null);
    io.runs.push({ id: 2, name: EVIDENCE_CHECK, head_sha: A, app: { slug: "github-actions" }, output: { text: "not json" } });
    assert.equal(await readEvidence({ io, repo: "acme/app", target: { commit: A } }), null);
  });
  it("promoteDecision re-reads the checks: a check that turned red after the attestation blocks the skip", async () => {
    const world = { ...WORLD, checks: { [A]: [...CHECKS] } };
    const io = fakeIo(world);
    await cli(["--attest", "--sha", A, "--digests", DIG], io);
    assert.equal((await promoteDecision({ io, repo: "acme/app", cfg: cfgE, sha: M, digests: IMAGES })).skip_pre_gate, true);
    world.checks[A].push(run("build", "failure", A, 50));
    const d = await promoteDecision({ io, repo: "acme/app", cfg: cfgE, sha: M, digests: IMAGES });
    assert.deepEqual([d.skip_pre_gate, d.reasons], [false, ["now build: failure, not success"]]);
  });
  it("promoteDecision: no evidence, an unreadable commit and mode off never skip", async () => {
    const io = fakeIo(WORLD);
    assert.deepEqual((await promoteDecision({ io, repo: "acme/app", cfg: cfgE, sha: M, digests: IMAGES })).reasons, ["no attestation for this commit"]);
    const d = await promoteDecision({ io, repo: "acme/app", cfg: cfgE, sha: h("9"), digests: IMAGES });
    assert.equal(d.skip_pre_gate, false);
    assert.match(d.reasons[0], /cannot read commit/);
    const off = fakeIo(WORLD);
    assert.equal((await promoteDecision({ io: off, repo: "acme/app", cfg: parsePromoteConfig(""), sha: M })).mode, "off");
    assert.deepEqual(off.calls, []);
  });
  it("shadow: --gate records would-skip but tells the workflow to run the pre-gate; --observed records agreement; --report counts", async () => {
    const io = fakeIo(WORLD), outputs = [];
    await cli(["--attest", "--sha", A, "--digests", DIG], io);
    assert.equal(await cli(["--gate", "--sha", M, "--digests", DIG, "--json"], io, YAML, { env: { GITHUB_OUTPUT: "/out" }, appendFile: (f, t) => outputs.push([f, t]) }), 0);
    assert.deepEqual(outputs, [["/out", "skip_pre_gate=false\nwould_skip=true\n"]]);
    const dec = io.runs.filter((r) => r.name === DECISION_CHECK);
    assert.deepEqual([dec.length, dec[0].head_sha], [1, M]);
    assert.deepEqual((({ would_skip, skipped, observed, agree, mode }) => ({ would_skip, skipped, observed, agree, mode }))(JSON.parse(dec[0].output.text)), { would_skip: true, skipped: false, observed: null, agree: null, mode: "shadow" });
    assert.equal(await cli(["--observed", "pass", "--sha", M, "--minutes", "23.7"], io), 0);
    const last = JSON.parse(io.runs.at(-1).output.text);
    assert.deepEqual([last.observed, last.agree, last.minutes, last.would_skip], ["pass", true, 23.7, true]);
    io.printed.length = 0;
    assert.equal(await cli(["--report", "--json"], io), 0);
    assert.deepEqual(JSON.parse(io.printed[0]).report, { decisions: 1, would_skip: 1, observed: 1, agree: 1, disagree: 0, minutes_saved: 23.7, exit_met: false });
  });
  it("shadow disagreement: a would-skip whose pre-gate failed is reported and fails the report", async () => {
    const io = fakeIo(WORLD);
    await cli(["--attest", "--sha", A, "--digests", DIG], io);
    await cli(["--gate", "--sha", M, "--digests", DIG], io);
    await cli(["--observed", "fail", "--sha", M], io);
    assert.match(io.printed.at(-1), /DISAGREE/);
    assert.equal(await cli(["--report"], io), 1);
    assert.match(io.printed.join("\n"), /1 disagree/);
    assert.equal(await cli(["--observed", "maybe", "--sha", M], io), 1);
    assert.equal(await cli(["--observed", "pass", "--sha", A], io), 1, "no decision recorded for that commit");
  });
  it("enforce: --gate skips on accepted evidence, and falls back when the decision cannot be recorded", async () => {
    const io = fakeIo(WORLD), outputs = [];
    await cli(["--attest", "--sha", A, "--digests", DIG], io, ENFORCE);
    await cli(["--gate", "--sha", M, "--digests", DIG], io, ENFORCE, { env: { GITHUB_OUTPUT: "/out" }, appendFile: (f, t) => outputs.push(t) });
    assert.deepEqual(outputs, ["skip_pre_gate=true\nwould_skip=true\n"]);
    const deny = fakeIo({ ...WORLD, denyPost: true });
    deny.runs.push({ id: 1, name: EVIDENCE_CHECK, head_sha: A, app: { slug: "github-actions" }, output: { text: JSON.stringify(att()) } });
    const outs2 = [];
    await cli(["--gate", "--sha", M, "--digests", DIG, "--json"], deny, ENFORCE, { env: { GITHUB_OUTPUT: "/out" }, appendFile: (f, t) => outs2.push(t) });
    assert.deepEqual(outs2, ["skip_pre_gate=false\nwould_skip=true\n"]);
    assert.match(JSON.parse(deny.printed.at(-1)).reasons.join(), /could not be recorded/);
  });
  it("enforce: wrong digests at the deploy side run the full pre-gate", async () => {
    const io = fakeIo(WORLD), outputs = [];
    await cli(["--attest", "--sha", A, "--digests", DIG], io, ENFORCE);
    await cli(["--gate", "--sha", M, "--digests", JSON.stringify({ ...IMAGES, api: dg("8") })], io, ENFORCE, { env: { GITHUB_OUTPUT: "/out" }, appendFile: (f, t) => outputs.push(t) });
    assert.deepEqual(outputs, ["skip_pre_gate=false\nwould_skip=false\n"]);
    assert.match(io.printed.join("\n"), /no: image api/);
  });
  it("--images: changed paths from --base, previous digests from the base commit's attestation", async () => {
    const io = fakeIo(WORLD);
    await cli(["--attest", "--sha", A, "--digests", DIG], io);
    io.printed.length = 0;
    assert.equal(await cli(["--images", "--base", A, "--sha", M, "--json"], io), 0);
    const p = JSON.parse(io.printed[0]);
    assert.deepEqual([p.build, p.reuse], [["web"], ["api", "worker"]]);
    assert.ok(io.calls.includes(`git diff --name-only ${A} ${M}`));
    io.printed.length = 0;
    await cli(["--images", "--sha", M], io);
    assert.match(io.printed.join("\n"), /build api: changed paths unknown/);
    io.printed.length = 0;
    await cli(["--images", "--changed", "docs/a.md", "--previous", DIG, "--sha", M, "--json"], io);
    assert.deepEqual(JSON.parse(io.printed[0]).build, []);
  });
});
