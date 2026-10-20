// forge#4176: /bootstrap — commands/bootstrap.md, templates/bootstrap/ and scripts/bootstrap-create.mjs. The create
// script runs against an in-memory fake GitHub (every gh call goes through the injected io), so these tests pin:
// nothing is written for an invalid plan, the backlog lands in build order with the spike, milestones, lane branches,
// board fields, FORGE:BOOTSTRAP_PLAN / FORGE:DECOMPOSED and workflow:decomposed, and a re-run or a resumed run
// creates no duplicates.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./_tmp.mjs";
import {
  checkSpikeDoc, injectGuardrails, subIssueOrder, planPreview, bootstrapPlanComment, decomposedComment,
  handoffText, createBacklog, preflight, priorityLabel, main, SPIKE_SECTIONS,
} from "../../scripts/bootstrap-create.mjs";
import { validatePlan } from "../../scripts/bootstrap-validate.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");
const REPO = "acme/app";
const DESIGN = [
  "### Design spec (UI issues)", "",
  "- **Breakpoints**: 360, 768, 1280",
  "- **States**: empty state, loading state, error state, offline state",
  "- **Motion**: 150ms fades, prefers-reduced-motion respected",
  "- **Accessibility**: WCAG 2.2 AA",
  "- **Dark mode**: token mapping in both themes",
  "- **Hero surface**: route the visual design to `/design` first.", "",
].join("\n");

/** The valid Next.js fixture plus the /bootstrap fields: priorities, components, a UI hero issue, guardrails. */
function samplePlan() {
  const plan = JSON.parse(read("bin/tests/fixtures/bootstrap-validate/valid-nextjs.json"));
  plan.spike = "SPIKE";
  plan.spikeDoc = "docs/engineering/technical-spike.md";
  plan.guardrails = ["no auto-send"];
  plan.domainRules = ["India-only data residency"];
  for (const it of plan.issues) { it.priority = it.key === "SPIKE" ? "p0" : "p1"; it.component = "Web"; }
  const dash = plan.issues.find((i) => i.key === "DASHBOARD");
  dash.ui = true; dash.hero = true;
  dash.body = dash.body.replace("## Context", `${DESIGN}\n## Context`);
  return plan;
}

const spikeText = () => read("templates/bootstrap/technical-spike.md");

/** In-memory GitHub behind the io the script uses. `failCreateAt` throws on the Nth issue create (resume tests). */
function fakeGitHub({ failCreateAt = 0, staging = true } = {}) {
  const s = {
    labels: new Set(["needs-human"]), milestones: [], refs: new Map(staging ? [["staging", "sha-staging"]] : []),
    issues: [], comments: new Map(), items: new Map(), edits: [], transitions: [], calls: [], creates: 0,
  };
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const fields = (args) => Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "-f" ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
  const gh = (args, input) => {
    s.calls.push(args);
    const [a, b] = args;
    if (a === "label" && b === "list") return JSON.stringify([...s.labels].map((name) => ({ name })));
    if (a === "label" && b === "create") { s.labels.add(args[2]); return ""; }
    if (a === "issue" && b === "list") {
      return JSON.stringify(s.issues.map((i) => ({ number: i.number, title: i.title, body: i.body, url: i.url, labels: i.labels.map((name) => ({ name })) })));
    }
    if (a === "issue" && b === "create") {
      s.creates++;
      if (failCreateAt && s.creates === failCreateAt) throw new Error("HTTP 502 (simulated)");
      const labels = args.flatMap((x, i) => (args[i - 1] === "--label" ? [x] : []));
      for (const l of labels) assert.ok(s.labels.has(l), `label ${l} must exist before use`);
      const milestone = flag(args, "--milestone");
      assert.ok(s.milestones.some((m) => m.title === milestone), `milestone ${milestone} must exist before use`);
      const number = 100 + s.issues.length;
      const url = `https://github.com/${REPO}/issues/${number}`;
      s.issues.push({ number, title: flag(args, "--title"), body: input, url, labels, milestone });
      return `Creating issue\n${url}\n`;
    }
    if (a === "issue" && b === "edit") { s.issues.find((i) => i.number === Number(args[2])).body = input; return ""; }
    if (a === "issue" && b === "comment") {
      const n = Number(args[2]);
      s.comments.set(n, [...(s.comments.get(n) ?? []), { body: input, user: { login: "forgedock[bot]", type: "Bot" }, author_association: "NONE" }]);
      return "";
    }
    if (a === "project" && b === "item-add") {
      const url = flag(args, "--url");
      if (!s.items.has(url)) s.items.set(url, `ITEM_${s.items.size + 1}`);
      return `${s.items.get(url)}\n`;
    }
    if (a === "project" && b === "item-edit") { s.edits.push({ item: flag(args, "--id"), field: flag(args, "--field-id"), option: flag(args, "--single-select-option-id") }); return ""; }
    if (a === "api") {
      const path = args.find((x) => x.startsWith("repos/"));
      if (path.startsWith(`repos/${REPO}/milestones?`)) return JSON.stringify(s.milestones);
      if (path === `repos/${REPO}/milestones`) { s.milestones.push({ title: fields(args).title, number: s.milestones.length + 1 }); return "{}"; }
      const ref = path.match(/git\/ref\/heads\/(.+)$/);
      if (ref) {
        if (!s.refs.has(ref[1])) throw new Error("HTTP 404: Not Found");
        return args.includes("--jq") ? `${s.refs.get(ref[1])}\n` : JSON.stringify({ object: { sha: s.refs.get(ref[1]) } });
      }
      if (path === `repos/${REPO}/git/refs`) { const f = fields(args); s.refs.set(f.ref.replace("refs/heads/", ""), f.sha); return "{}"; }
      const com = path.match(/issues\/(\d+)\/comments$/);
      if (com) return JSON.stringify(s.comments.get(Number(com[1])) ?? []);
    }
    throw new Error(`fake gh: unexpected call ${args.join(" ")}`);
  };
  const sh = (cmd, args, input) => {
    if (args[0].endsWith("transition-label.sh")) {
      s.transitions.push(args.slice(1));
      const issue = s.issues.find((i) => i.number === Number(args[1]));
      issue.labels = [...issue.labels.filter((l) => !l.startsWith("workflow:")), `workflow:${args.at(-1)}`];
      return "";
    }
    // The real trusted-comments.sh: the same trust predicate decompose uses.
    return execFileSync(cmd, args, { encoding: "utf8", input, env: { ...process.env, FORGE_TRAIL_TRUSTED_ASSOCIATIONS: "OWNER,MEMBER,COLLABORATOR", FORGE_TRAIL_TRUSTED_LOGINS: "" } });
  };
  return { s, io: { gh, sh } };
}

const CONFIG = {
  branches: { staging: "staging", feature_pattern: "milestone/{slug}" },
  project: { owner: "acme", repo: "app" },
  project_board: {
    owner: "acme", project_number: 7, project_id: "PVT_1",
    field_ids: { status: "F_STATUS", priority: "F_PRIO", component: "F_COMP" },
    option_ids: { status: { todo: "O_TODO" }, priority: { p0: "O_P0", p1: "O_P1" } },
    components: [{ repo: "acme/other", option_id: "O_OTHER", label: "Other" }, { repo: REPO, option_id: "O_WEB", label: "Web" }],
  },
};
const mutating = (calls) => calls.filter((c) =>
  (c[0] === "issue" && ["create", "edit", "comment"].includes(c[1])) || (c[0] === "label" && c[1] === "create") || c.includes("POST"));

describe("bootstrap-create preflight: nothing is written for an invalid plan or spike doc", () => {
  test("the sample plan and the spike template pass", () => {
    assert.deepEqual(validatePlan(samplePlan()).errors, []);
    assert.deepEqual(preflight(samplePlan(), spikeText()), []);
  });

  test("the spike template has every section, each with an ADR-style rationale", () => {
    assert.deepEqual(checkSpikeDoc(spikeText()), { ok: true, missing: [], noRationale: [] });
    for (const name of ["Stack", "Repo layout", "Runtime topology", "Data model", "Security and privacy",
      "Design system and quality gates", "Route/API map", "Credentials", "Milestone plan"]) assert.ok(SPIKE_SECTIONS.includes(name), name);
    assert.match(spikeText(), /bootstrap-to-scale path/);
  });

  test("a spike doc missing a section or a rationale is rejected", () => {
    const noData = spikeText().replace("## Data model", "## Something else");
    assert.deepEqual(checkSpikeDoc(noData).missing, ["Data model"]);
    const noWhy = spikeText().replace(/(## Stack[\s\S]*?)\*\*Rationale\*\*:/, "$1Why:");
    assert.deepEqual(checkSpikeDoc(noWhy).noRationale, ["Stack"]);
    assert.ok(preflight(samplePlan(), noWhy).some((e) => e.includes("[missing-rationale]")));
    assert.ok(preflight(samplePlan(), null).some((e) => e.includes("[missing-spike-doc]")));
  });

  test("CLI: an invalid plan exits 1 without a single gh call; --dry-run previews without GitHub", () => {
    const dir = tmpDir("bootstrap-create-");
    mkdirSync(join(dir, "docs/engineering"), { recursive: true });
    writeFileSync(join(dir, "docs/engineering/technical-spike.md"), spikeText());
    const bad = samplePlan();
    bad.issues.find((i) => i.key === "DASHBOARD").body = bad.issues.find((i) => i.key === "DASHBOARD").body.replace("Dark mode", "Theme");
    writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
    writeFileSync(join(dir, "good.json"), JSON.stringify(samplePlan()));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const { s, io } = fakeGitHub();
      let out = "", err = "";
      const sink = { out: { write: (x) => { out += x; } }, err: { write: (x) => { err += x; } } };
      assert.equal(main(["bad.json", "--repo", REPO], { io, ...sink }), 1);
      assert.match(err, /DASHBOARD: \[missing-design-spec\]/);
      assert.match(err, /not creating anything/);
      assert.equal(main(["good.json", "--dry-run"], { io, ...sink }), 0);
      assert.match(out, /dry run: nothing written to GitHub/);
      assert.match(out, /milestone\/foundation/);
      assert.equal(s.calls.length, 0);
      assert.equal(main([], { io, ...sink }), 2);
    } finally { process.chdir(cwd); }
  });
});

describe("bootstrap-create: backlog creation", () => {
  test("creates the spike, milestones with lane branches in build order, sub-issues, board fields and decomposed marker", () => {
    const { s, io } = fakeGitHub();
    const plan = samplePlan();
    const r = createBacklog(plan, { io, repo: REPO, config: CONFIG });

    // Spike parent first, then milestones in build order with milestone/<slug> branches cut from staging.
    assert.equal(s.issues[0].title, plan.issues[0].title);
    assert.deepEqual(s.milestones.map((m) => m.title), plan.milestones.map((m) => m.title));
    for (const m of plan.milestones) {
      const slug = m.title.toLowerCase().replace(/ /g, "-").replace(/[^a-z0-9-]/g, "");
      assert.equal(s.refs.get(`milestone/${slug}`), "sha-staging", m.title);
    }
    assert.deepEqual(r.milestones.map((m) => m.orchestrate), plan.milestones.map((m) => `/orchestrate milestone "${m.title}"`));

    // Every sub-issue: Parent resolved to the spike, no placeholder left, guardrails and domain rules in Context.
    const spikeNo = r.spike.number;
    assert.equal(s.issues.length, plan.issues.length);
    for (const i of s.issues) {
      assert.doesNotMatch(i.body, /#\{\{/, i.title);
      assert.match(i.body, /## Context[\s\S]*\*\*Guardrails\*\*:\n- no auto-send[\s\S]*\*\*Domain rules\*\*:\n- India-only data residency[\s\S]*## Dependencies/, i.title);
      if (i.number !== spikeNo) assert.match(i.body, new RegExp(`\\*\\*Parent\\*\\*: #${spikeNo}\\b`), i.title);
      assert.ok(i.labels.includes(i.number === spikeNo ? "priority:P0" : "priority:P1"), i.title);
    }
    const dash = s.issues.find((i) => i.title === plan.issues.find((p) => p.key === "DASHBOARD").title);
    const auth = s.issues.find((i) => i.title === plan.issues.find((p) => p.key === "AUTH").title);
    const db = s.issues.find((i) => i.title === plan.issues.find((p) => p.key === "DB").title);
    assert.match(dash.body, new RegExp(`Depends on #${auth.number}\\b`));
    assert.match(dash.body, new RegExp(`Depends on #${db.number}\\b`));

    // Board: every issue gets Status=Todo, Priority and the Component named by the plan.
    assert.equal(s.items.size, plan.issues.length);
    for (const item of s.items.values()) {
      const e = s.edits.filter((x) => x.item === item);
      assert.ok(e.some((x) => x.field === "F_STATUS" && x.option === "O_TODO"), item);
      assert.ok(e.some((x) => x.field === "F_PRIO" && ["O_P0", "O_P1"].includes(x.option)), item);
      assert.ok(e.some((x) => x.field === "F_COMP" && x.option === "O_WEB"), item);
    }

    // Spike: FORGE:BOOTSTRAP_PLAN + FORGE:DECOMPOSED listing every sub-issue, then workflow:decomposed.
    const comments = s.comments.get(spikeNo).map((c) => c.body);
    assert.equal(comments.length, 2);
    assert.match(comments[0], /^<!-- FORGE:BOOTSTRAP_PLAN -->\n[\s\S]*^Spike: `docs\/engineering\/technical-spike\.md`$[\s\S]*### Decomposition Assessment\n\n\*\*YES\*\*/m);
    const decomposed = comments[1];
    assert.match(decomposed, /^<!-- FORGE:DECOMPOSED -->/);
    assert.match(decomposed, /\*\*Plan source\*\*: bootstrap/);
    assert.match(decomposed, /<!-- FORGE:DECOMPOSED:COMPLETE -->$/);
    const listed = [...decomposed.matchAll(/^- #(\d+): /gm)].map((m) => Number(m[1])).sort();
    assert.deepEqual(listed, s.issues.filter((i) => i.number !== spikeNo).map((i) => i.number).sort());
    assert.deepEqual(s.transitions, [[String(spikeNo), "-R", REPO, "decomposed"]]);
    assert.ok(s.issues[0].labels.includes("workflow:decomposed"));

    // Hand-off: created links, needs-human links, /orchestrate per milestone in order.
    const h = handoffText(r);
    const human = s.issues.find((i) => i.labels.includes("needs-human"));
    assert.match(h, new RegExp(`### Needs a human\\n- #${human.number} [^\\n]+ — ${human.url}`));
    assert.match(h, new RegExp(`### Created\\n[\\s\\S]*${dash.url}[\\s\\S]*### Needs a human`));
    assert.match(h, /### Next commands \(in build order\)\n1\. \/orchestrate milestone "[^"]+"\n2\. \/orchestrate milestone "[^"]+"\n3\. /);
  });

  test("a re-run reuses everything: no new issue, milestone, branch, comment or label transition", () => {
    const { s, io } = fakeGitHub();
    const first = createBacklog(samplePlan(), { io, repo: REPO, config: CONFIG });
    const before = s.calls.length;
    const again = createBacklog(samplePlan(), { io, repo: REPO, config: CONFIG });
    assert.deepEqual(mutating(s.calls.slice(before)), []);
    assert.equal(s.transitions.length, 1);
    assert.deepEqual(again.issues.map((i) => i.number), first.issues.map((i) => i.number));
    assert.ok(again.issues.every((i) => i.reused) && again.spike.reused);
  });

  test("a same-title issue under another parent is not reused", () => {
    const { s, io } = fakeGitHub();
    const plan = samplePlan();
    const db = plan.issues.find((i) => i.key === "DB");
    s.issues.push({ number: 50, title: db.title, body: "## Context\n\n**Parent**: #49\n", url: `https://github.com/${REPO}/issues/50`, labels: [] });
    const r = createBacklog(plan, { io, repo: REPO, config: CONFIG });
    assert.notEqual(r.issues.find((i) => i.key === "DB").number, 50);
  });

  test("an interrupted run resumes without duplicates and resolves every forward reference", () => {
    const { s, io } = fakeGitHub({ failCreateAt: 4 });
    const plan = samplePlan();
    assert.throws(() => createBacklog(plan, { io, repo: REPO, config: CONFIG }), /502/);
    assert.equal(s.issues.length, 3);
    s.creates = 100; // past the simulated failure: the re-run succeeds
    createBacklog(plan, { io, repo: REPO, config: CONFIG });
    assert.equal(s.issues.length, plan.issues.length);
    assert.equal(new Set(s.issues.map((i) => i.title)).size, plan.issues.length);
    for (const i of s.issues) assert.doesNotMatch(i.body, /#\{\{/, i.title);
  });

  test("without a configured board, creation still completes and notes the skip", () => {
    const { s, io } = fakeGitHub();
    const r = createBacklog(samplePlan(), { io, repo: REPO, config: { branches: CONFIG.branches } });
    assert.equal(s.items.size, 0);
    assert.ok(r.notes.some((n) => /board sync skipped/.test(n)));
  });
});

describe("bootstrap-create helpers", () => {
  test("injectGuardrails appends to Context only, once", () => {
    const body = "## Problem\n\nx\n\n## Context\n\n**Parent**: #1\n\n## Dependencies\n\nNone.\n";
    const once = injectGuardrails(body, ["no auto-send"], []);
    assert.equal(once, "## Problem\n\nx\n\n## Context\n\n**Parent**: #1\n\n**Guardrails**:\n- no auto-send\n\n## Dependencies\n\nNone.\n");
    assert.equal(injectGuardrails(once, ["no auto-send"], []), once);
    assert.equal(injectGuardrails(body, [], []), body);
  });

  test("subIssueOrder puts dependencies first and leaves out the spike", () => {
    const plan = samplePlan();
    const order = subIssueOrder(plan).map((i) => i.key);
    assert.ok(!order.includes("SPIKE"));
    for (const it of plan.issues) for (const d of it.deps ?? []) if (d !== "SPIKE" && it.key !== "SPIKE") assert.ok(order.indexOf(d) < order.indexOf(it.key), `${d} before ${it.key}`);
  });

  test("comment bodies match the shapes decompose parses", () => {
    const plan = samplePlan();
    const bp = bootstrapPlanComment(plan);
    // Same extraction as commands/work-on/decompose.md Phase D0 (PLAN_SPIKE).
    const spike = bp.split("\n").map((l) => l.match(/^Spike: *`?([^` ]+)`? *$/)).find(Boolean);
    assert.equal(spike[1], "docs/engineering/technical-spike.md");
    const numbers = new Map(plan.issues.map((it, i) => [it.key, i + 1]));
    const dc = decomposedComment(plan, numbers, { attribution: false });
    assert.equal([...dc.matchAll(/^- #(\d+)/gm)].length, plan.issues.length - 1);
    assert.doesNotMatch(dc, /Pipeline powered by/);
    assert.equal(priorityLabel({ priority: "P2" }), "priority:P2");
    assert.equal(priorityLabel({}), null);
    assert.match(planPreview(plan), /needs-human/);
  });
});

describe("/bootstrap spec and templates", () => {
  const spec = read("commands/bootstrap.md");
  const interview = read("templates/bootstrap/interview.md");

  test("the spec stays within the new-spec budget and routes every step to the scripts", () => {
    assert.ok(Buffer.byteLength(spec) <= 4096, `commands/bootstrap.md is ${Buffer.byteLength(spec)} bytes`);
    assert.match(spec, /forge_resolve bootstrap-validate\.mjs/);
    assert.match(spec, /forge_resolve bootstrap-create\.mjs/);
    assert.match(spec, /Here's what I assumed/);
    assert.match(spec, /at most 4 multiple-choice questions per batch, each with a recommended option/);
    assert.match(spec, /docs\/engineering\/technical-spike\.md/);
    assert.match(spec, /never depend on it/);
    assert.match(spec, /\/orchestrate/);
    assert.doesNotMatch(spec, /Skill\(/);
  });

  test("--spike picks the spike doc path and reaches the plan's spikeDoc", () => {
    assert.match(spec, /^argument-hint: "<free text \| path to docs> \[--dry-run\] \[--spike <path>\]"$/m);
    assert.match(spec, /`--spike` \(default `docs\/engineering\/technical-spike\.md`\)/);
    assert.match(spec, /plan's `spikeDoc`/);
  });

  test("the interview bank covers every aspect of the product", () => {
    for (const aspect of ["Users and segments", "Core jobs and features", "Scope", "Platforms", "Stack", "Auth",
      "Data and tenancy", "Integrations", "Payments", "i18n", "Compliance and residency", "Design ambition and UI libraries",
      "Deployment target", "Scale", "Budget", "Team", "Timeline"]) assert.match(interview, new RegExp(`\\| ${aspect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`), aspect);
    assert.match(interview, /product name/);
    assert.match(interview, /repo owner/);
  });

  test("stack presets cover a Next.js + shadcn SaaS, a Python API and mobile", () => {
    const p = read("templates/bootstrap/stack-profiles.md");
    for (const h of ["## Next.js + shadcn SaaS", "## Python API", "## Mobile"]) assert.ok(p.includes(h), h);
  });

  test("filled-in issue and needs-human templates pass the validator", () => {
    const fill = (t, values) => t.slice(t.indexOf("\n## Problem") + 1)
      // Fill single-brace slots; #{{KEY}} plan placeholders stay for the validator to resolve.
      .replace(/(?<!\{)\{([^{}]*)\}(?!\})/g, (m, k) => values[k] ?? (/^[A-Z_]+$/.test(k) ? k : "x"));
    const ui = fill(read("templates/bootstrap/issue-body.md"), {}).replace(/^Depends on .*$/m, "Depends on #{{DB}} — schema");
    const human = fill(read("templates/bootstrap/needs-human-issue.md"), {});
    const plan = {
      milestones: [{ key: "m1", title: "Foundation" }],
      issues: [
        { key: "SPIKE", title: "spike", milestone: "m1", labels: ["infra"], body: ui.replace(/\*\*Parent\*\*: .*/, "**Parent**: none (spike)").replace(/^Depends on .*$/m, "None.").replace(/#\{\{[A-Z_]+\}\}/g, "") },
        { key: "DB", title: "db", milestone: "m1", labels: ["backend"], deps: [], body: ui.replace(/^Depends on .*$/m, "None.").replace(/see #\{\{NEEDS_HUMAN_KEY\}\}/, "see #{{CREDS}}") },
        { key: "PAGE", title: "page", milestone: "m1", labels: ["frontend"], ui: true, hero: true, deps: ["DB"], body: ui.replace(/see #\{\{NEEDS_HUMAN_KEY\}\}/, "see #{{CREDS}}") },
        { key: "CREDS", title: "creds", milestone: "m1", labels: ["needs-human"], needsHuman: true, body: human },
      ],
    };
    assert.deepEqual(validatePlan(plan).errors, []);
    // And the checks bite: strip the hero line / an env var from the filled templates.
    plan.issues[2].body = plan.issues[2].body.replace(/^- \*\*Hero surface\*\*.*$/m, "");
    plan.issues[3].body = plan.issues[3].body.replace(/^### Secret handling$/m, "Notes");
    const codes = validatePlan(plan).errors.map((e) => `${e.issue}:${e.code}`).sort();
    assert.deepEqual(codes, ["CREDS:missing-needs-human-section", "PAGE:hero-not-routed"]);
  });
});
