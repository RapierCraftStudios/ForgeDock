import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { routePathOf, routePathsFromFiles, routeReachabilityFailures } from "./routecheck.mjs";
import { readEnvConfig } from "../engine-cli.mjs";
import { tmpDir } from "../tests/_tmp.mjs";

// Stand-in for AlterLab's scripts/generate-traefik-config.sh: the api-router sends /api/v1/* to FastAPI;
// only /api/v1/batch and /api/v1/b2b/jobs go to web (#5087).
const dir = tmpDir("routecheck-");
const ingress = join(dir, "check-ingress.sh");
writeFileSync(ingress, `#!/usr/bin/env bash
rc=0
for p in "$@"; do
  case "$p" in
    /api/v1/batch|/api/v1/batch/*|/api/v1/b2b/jobs|/api/v1/b2b/jobs/*) ;;
    /api/v1/*) echo "unreachable: $p is routed to api (FastAPI) by api-router, not web" >&2; rc=1 ;;
  esac
done
exit $rc
`);
const run = async ({ command }) => { const r = spawnSync("bash", ["-c", command], { encoding: "utf8" }); return { rc: r.status, output: `${r.stdout}${r.stderr}` }; };
const SIGNUP = ["web/src/app/(site)/api/v1/agent/signup/pending/route.ts", "web/src/app/(site)/api/v1/agent/signup/by-code/[code]/route.ts"];

describe("#5087 route reachability", () => {
  it("maps Next.js handler files to URL paths", () => {
    assert.equal(routePathOf(SIGNUP[0]), "/api/v1/agent/signup/pending");
    assert.equal(routePathOf(SIGNUP[1]), "/api/v1/agent/signup/by-code/[code]");
    assert.equal(routePathOf("web/src/pages/api/health/index.ts"), "/api/health");
    assert.equal(routePathOf("web/src/app/route.ts"), "/");
    assert.equal(routePathOf("web/src/app/page.tsx"), null);
    assert.equal(routePathOf("bin/lean/routecheck.mjs"), null);
    assert.deepEqual(routePathsFromFiles([...SIGNUP, SIGNUP[0], "README.md"]), ["/api/v1/agent/signup/by-code/[code]", "/api/v1/agent/signup/pending"]);
  });
  it("fixture ingress routes /api/v1/agent/signup to FastAPI and fails the check", async () => {
    const f = await routeReachabilityFailures({ command: `bash ${ingress}`, paths: routePathsFromFiles(SIGNUP), run });
    assert.equal(f.length, 1);
    assert.equal(f[0].code, "conformance.unimplemented");
    assert.equal(f[0].kind, "route_unreachable");
    assert.match(f[0].detail, /signup\/pending/);
  });
  it("passes a route the ingress delivers to web", async () => {
    assert.deepEqual(await routeReachabilityFailures({ command: `bash ${ingress}`, paths: ["/api/v1/batch"], run }), []);
  });
  it("a passing command wrapped as {r: {rc, output}} (lean io.runCommand shape) is not reported as a failure", async () => {
    const wrapped = async (a) => ({ r: await run(a) });
    assert.deepEqual(await routeReachabilityFailures({ command: `bash ${ingress}`, paths: ["/api/v1/batch"], run: wrapped }), []);
    assert.equal((await routeReachabilityFailures({ command: `bash ${ingress}`, paths: ["/api/v1/agent/signup/pending"], run: wrapped })).length, 1);
  });
  it("is a no-op without a declared command or without added routes", async () => {
    const never = async () => { throw new Error("must not run"); };
    assert.deepEqual(await routeReachabilityFailures({ command: undefined, paths: ["/api/v1/x"], run: never }), []);
    assert.deepEqual(await routeReachabilityFailures({ command: "false", paths: [], run: never }), []);
  });
  it("a command that cannot run is reported, not swallowed", async () => {
    const f = await routeReachabilityFailures({ command: "x", paths: ["/a"], run: async () => { throw new Error("boom"); } });
    assert.equal(f[0].kind, "route_unreachable");
    assert.match(f[0].detail, /exited 127/);
  });
  it("forge.yaml topology.route_reachability is read; repos without topology get no key", () => {
    const withKey = tmpDir("rc-yaml-"), without = tmpDir("rc-yaml-");
    writeFileSync(join(withKey, "forge.yaml"), "topology:\n  route_reachability: \"bash scripts/check-ingress.sh\"\n");
    writeFileSync(join(without, "forge.yaml"), "project: x/y\n");
    assert.equal(readEnvConfig(withKey).routeReachability, "bash scripts/check-ingress.sh");
    assert.equal("routeReachability" in readEnvConfig(without), false);
  });
});
