// forge#4175: /milestone accepts a precomputed /bootstrap plan and skips code-read gating for greenfield
// milestones; work-on/decompose accepts a spike issue whose Decomposition Assessment comes from a trusted
// FORGE:BOOTSTRAP_PLAN comment. These tests pin both greenfield paths and that brownfield gating is unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");
const fixtures = "bin/tests/fixtures/bootstrap-plan";
const milestone = read("commands/milestone.md");
const decompose = read("commands/work-on/decompose.md");
const section = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `missing section ${from}`);
  const end = to ? text.indexOf(to, start + from.length) : -1;
  return text.slice(start, end > start ? end : undefined);
};
const bash = (script, args = [], input) =>
  spawnSync("bash", ["-c", script, "x", ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    env: { ...process.env, FORGE_TRAIL_TRUSTED_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR", FORGE_TRAIL_TRUSTED_LOGINS: "" },
  });

describe("milestone greenfield / precomputed plan", () => {
  const step1 = section(milestone, "### Step 1: Parse the milestone scope", "### Step 2:");
  const step4 = section(milestone, "### Step 4: Scope decomposition", "### Step 5:");
  const setup = step1.match(/```bash\n([\s\S]*?)```/)[1];

  it("parses --plan, --greenfield and --spike", () => {
    for (const flag of ["--plan <file>", "--greenfield", "--spike <path>"]) assert.ok(step1.includes(flag), flag);
    assert.match(milestone, /argument-hint: "\[create <name> \[--plan <file>\] \[--greenfield\] \[--spike <path>\]/);
  });

  it("skips the 4B code reads only in greenfield mode and validates planned paths against the spike layout", () => {
    assert.match(step4, /\*\*Greenfield mode\*\* \(`GREENFIELD=true`\): skip 4A–4C and run \*\*Step 4G\*\*/);
    const g = section(step4, "**4G:", "**Project ecosystem context**");
    assert.match(g, /per-issue code reads of 4B are skipped/);
    assert.match(g, /PLAN_FILE/);
    assert.match(g, /forge_resolve affected-files-check\.sh/);
    assert.match(g, /bash "\$AF_CHECK_SCRIPT" "\$PLAN_ISSUE_BODY_FILE" --spike "\$SPIKE_DOC"/);
    assert.match(g, /^\s*type forge_resolve >\/dev\/null 2>&1/m);
  });

  it("keeps brownfield code-read gating, the milestone branch and board creation", () => {
    assert.match(step4, /do NOT skip code reads/);
    assert.match(step4, /\*\*4B: Per-issue investigation \(MANDATORY before writing any issue body\)\*\*/);
    assert.match(milestone, /git branch milestone\/\{slug\} origin\/\$DEFAULT_BRANCH/);
    assert.match(milestone, /### Step 6B: Add issues to Project board/);
    assert.match(step4, /Steps 2, 3 \(the `milestone\/\{slug\}` branch\), 5, 6 and 6B run unchanged in both modes/);
  });

  it("forwards --greenfield --spike to /issue only in greenfield mode", () => {
    assert.match(milestone, /--milestone \\"\{TITLE\}\\"\$\{GREENFIELD_ARGS\}"\)\)/);
    const run = (assign) => bash(`${assign}\n${setup.split("\n").slice(1).join("\n")}\nprintf '%s|%s' "$GREENFIELD" "$GREENFIELD_ARGS"`).stdout;
    assert.equal(run('PLAN_FILE=""; GREENFIELD=false; SPIKE_DOC="docs/engineering/technical-spike.md"'), "false|");
    assert.equal(
      run(`PLAN_FILE="plan.md"; GREENFIELD=false; SPIKE_DOC="${fixtures}/spike.md"`),
      `true| --greenfield --spike "${fixtures}/spike.md"`,
    );
  });

  it("fixture: planned paths in the spike layout pass, off-layout paths fail", () => {
    const af = (body) => bash('bash scripts/affected-files-check.sh "$1" --spike "$2"', [`${fixtures}/${body}`, `${fixtures}/spike.md`]);
    const ok = af("plan-issue-body.md");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^PLANNED apps\/web\/src\/app\/page\.tsx$/m);
    const bad = af("off-layout-body.md");
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /^MISSING services\/billing\/main\.go$/m);
  });
});

describe("decompose accepts a /bootstrap spike plan", () => {
  const d0 = section(decompose, "## Phase D0", "## Phase D1:");
  const d1 = section(decompose, "## Phase D1:", "## Phase D1.5");

  it("reads only a trusted, marker-anchored FORGE:BOOTSTRAP_PLAN comment and lets an investigator report win", () => {
    assert.match(d0, /bash "\$TRUSTED_SCRIPT" bodies '\^<!-- FORGE:BOOTSTRAP_PLAN -->'/);
    assert.match(d0, /TRUSTED_SCRIPT=\$\(forge_resolve trusted-comments\.sh\)\s+# unresolved => empty => fail closed/);
    assert.match(d0, /when a FORGE:INVESTIGATOR report exists it is the plan source \(`PLAN_SOURCE=investigate`\) and the bootstrap plan is ignored/);
    assert.match(d0, /`FORGE:DIFF_SIZE`, `FORGE:SIZE_OVERRIDE`, `FORGE:BOOTSTRAP_PLAN`\) in this scan/);
  });

  it("Guards 2 and 3 accept the bootstrap plan and keep the brownfield blockers", () => {
    assert.match(d1, /no trusted `\/bootstrap` plan \(`BOOTSTRAP_PLAN` empty, Phase D0\) → BLOCKED, blocker: "No investigation report found — run investigate first"/);
    assert.match(d1, /blocker: "Investigation report has no decomposition plan — re-run investigate with explicit decomposition scope"/);
    assert.match(d1, /When `PLAN_SOURCE=bootstrap` the same check applies/);
    assert.match(d1, /Guard 1 — issue is itself a sub-issue/);
  });

  it("reuses Parent, FORGE:DECOMPOSED and workflow:decomposed semantics, recording the plan source", () => {
    assert.match(decompose, /^\*\*Parent\*\*: #\{NUMBER\}$/m);
    assert.match(decompose, /COMMENT_URL=\$\(gh issue comment \{NUMBER\} \{GH_FLAG\} --body "<!-- FORGE:DECOMPOSED -->/);
    assert.match(decompose, /\*\*Plan source\*\*: \$\{PLAN_SOURCE\}/);
    assert.match(decompose, /SOLE owner of the `workflow:decomposed` label/);
    assert.match(decompose, /\$\{MILESTONE_ARG\}\$\{SPIKE_ARG\}"\)\)/);
    assert.match(decompose, /\[ "\$PLAN_SOURCE" = "bootstrap" \] && \[ -n "\$PLAN_SPIKE" \] && SPIKE_ARG=" --greenfield --spike/);
  });

  it("fixture: the trusted bot plan is selected, the untrusted copy is dropped, and the spike path is parsed", () => {
    const comments = read(`${fixtures}/comments.json`);
    const sel = bash(`bash scripts/trusted-comments.sh bodies '^<!-- FORGE:BOOTSTRAP_PLAN -->'`, [], comments);
    assert.equal(sel.status, 0, sel.stderr);
    const bodies = sel.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(bodies.length, 1);
    assert.match(bodies[0], /### Decomposition Assessment/);
    assert.match(bodies[0], /^1\. feat\(web\): landing page/m);
    assert.doesNotMatch(bodies[0], /exfiltrate/);

    const spikeLine = d0.split("\n").find((l) => l.startsWith("PLAN_SPIKE="));
    assert.ok(spikeLine, "PLAN_SPIKE extraction line");
    const spike = bash(`BOOTSTRAP_PLAN=$(cat)\n${spikeLine}\nprintf '%s' "$PLAN_SPIKE"`, [], bodies[0]);
    assert.equal(spike.stdout, "docs/engineering/technical-spike.md");
  });
});
