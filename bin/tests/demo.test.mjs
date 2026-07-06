/**
 * bin/tests/demo.test.mjs
 *
 * Unit tests for bin/demo.mjs — `forgedock demo` one-command demo mode (#1145).
 *
 * Covers (all without network, git, or a real `claude` on PATH):
 *   - parseDemoArgs: flags, =forms, positional, unknown-flag + missing-value errors
 *   - resolveTargetDir: default ~/forgedock-demo, --dir/positional, relative→absolute
 *   - demoForgeYaml / demoUsage / renderNextSteps: rendering invariants
 *   - runDemo: clone success, clone→scaffold fallback, idempotent re-run (git pull
 *     + non-git reuse), missing scaffold error, forge.yaml backfill, --open launch,
 *     --help, arg error
 *
 * Run with: node --test bin/tests/demo.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, isAbsolute } from "node:path";

import {
  DEFAULT_DEMO_REPO,
  DEFAULT_DEMO_DIRNAME,
  parseDemoArgs,
  resolveTargetDir,
  isGitRepo,
  demoUsage,
  demoForgeYaml,
  renderNextSteps,
  runDemo,
} from "../demo.mjs";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build an in-memory filesystem facade. `present` is a Set of paths that
 * "exist". Writes/mkdir/copy mutate it so existence checks stay consistent.
 */
function makeFsx({ present = [], dirContents = {} } = {}) {
  const set = new Set(present);
  const contents = { ...dirContents };
  const writes = [];
  const copies = [];
  return {
    _set: set,
    _writes: writes,
    _copies: copies,
    existsSync: (p) => set.has(p),
    mkdirSync: (p) => set.add(p),
    readdirSync: (p) => contents[p] || [],
    writeFileSync: (p, data) => {
      set.add(p);
      writes.push({ path: p, data });
    },
    cpSync: (src, dest) => {
      set.add(dest);
      copies.push({ src, dest });
    },
  };
}

/** Record exec calls and reply per-command via a router fn. */
function makeExec(router = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const exec = (cmd, cmdArgs, opts) => {
    calls.push({ cmd, args: cmdArgs, opts });
    return router(cmd, cmdArgs, opts);
  };
  exec.calls = calls;
  return exec;
}

function makeLogger() {
  const out = [];
  const err = [];
  return {
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    _out: out,
    _err: err,
    text: () => out.join("\n"),
    errtext: () => err.join("\n"),
  };
}

const HOME = "/home/dev";
const FORGE_HOME = "/pkg/forgedock";
const SCAFFOLD = join(FORGE_HOME, "examples", "forgedock-demo");

// ---------------------------------------------------------------------------
// parseDemoArgs
// ---------------------------------------------------------------------------

describe("parseDemoArgs", () => {
  it("defaults: no open, no error", () => {
    const p = parseDemoArgs([]);
    assert.equal(p.open, false);
    assert.equal(p.help, false);
    assert.equal(p.error, null);
    assert.equal(p.dir, undefined);
  });

  it("parses --dir, --repo (space and = forms) and --open", () => {
    assert.equal(parseDemoArgs(["--dir", "/x"]).dir, "/x");
    assert.equal(parseDemoArgs(["--dir=/y"]).dir, "/y");
    assert.equal(parseDemoArgs(["--repo", "a/b"]).repo, "a/b");
    assert.equal(parseDemoArgs(["--repo=c/d"]).repo, "c/d");
    assert.equal(parseDemoArgs(["--open"]).open, true);
    assert.equal(parseDemoArgs(["--open", "--no-open"]).open, false);
  });

  it("captures a positional target", () => {
    assert.equal(parseDemoArgs(["./mydemo"]).positional, "./mydemo");
  });

  it("--help / -h set help", () => {
    assert.equal(parseDemoArgs(["--help"]).help, true);
    assert.equal(parseDemoArgs(["-h"]).help, true);
  });

  it("errors on unknown flag and missing values", () => {
    assert.match(parseDemoArgs(["--nope"]).error, /Unknown flag/);
    assert.match(parseDemoArgs(["--dir"]).error, /--dir requires/);
    assert.match(parseDemoArgs(["--repo"]).error, /--repo requires/);
  });
});

// ---------------------------------------------------------------------------
// resolveTargetDir
// ---------------------------------------------------------------------------

describe("resolveTargetDir", () => {
  it("defaults to <home>/forgedock-demo", () => {
    assert.equal(
      resolveTargetDir({ home: HOME, cwd: "/work" }),
      join(HOME, DEFAULT_DEMO_DIRNAME),
    );
  });

  it("--dir wins over positional and is returned absolute", () => {
    assert.equal(resolveTargetDir({ dir: "/abs", positional: "rel", home: HOME }), "/abs");
  });

  it("resolves a relative positional against cwd", () => {
    const r = resolveTargetDir({ positional: "demo", cwd: "/work", home: HOME });
    assert.ok(isAbsolute(r));
    assert.match(r, /demo$/);
  });
});

// ---------------------------------------------------------------------------
// rendering helpers
// ---------------------------------------------------------------------------

describe("rendering helpers", () => {
  it("demoUsage mentions the default location and key flags", () => {
    const u = demoUsage();
    assert.match(u, /forgedock-demo/);
    assert.match(u, /--dir/);
    assert.match(u, /--open/);
  });

  it("demoForgeYaml splits owner/name and yields required sections", () => {
    const y = demoForgeYaml("acme/widget");
    assert.match(y, /owner: "acme"/);
    assert.match(y, /repo: "widget"/);
    assert.match(y, /^project:/m);
    assert.match(y, /^paths:/m);
    assert.match(y, /^branches:/m);
  });

  it("renderNextSteps shows the target path and /work-on 1", () => {
    const card = renderNextSteps({ target: "/t/demo", source: "cloned", claudeAvailable: true });
    assert.match(card, /\/t\/demo/);
    assert.match(card, /\/work-on 1/);
    assert.match(card, /Cloned the live demo repo/);
  });
});

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe("isGitRepo", () => {
  it("true when .git is present", () => {
    const fsx = makeFsx({ present: [join("/t", ".git")] });
    assert.equal(isGitRepo("/t", fsx), true);
  });
  it("false otherwise", () => {
    const fsx = makeFsx();
    assert.equal(isGitRepo("/t", fsx), false);
  });
});

// ---------------------------------------------------------------------------
// runDemo
// ---------------------------------------------------------------------------

describe("runDemo", () => {
  const TARGET = join(HOME, DEFAULT_DEMO_DIRNAME);

  it("clones the live repo when git clone succeeds", async () => {
    const fsx = makeFsx(); // target absent
    const logger = makeLogger();
    const exec = makeExec((cmd, a) => {
      if (cmd === "git" && a[0] === "clone") {
        fsx._set.add(TARGET); // simulate clone creating the dir
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: [],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });

    assert.equal(r.status, "ok");
    assert.equal(r.source, "cloned");
    assert.equal(r.target, TARGET);
    // No scaffold copy on the clone path.
    assert.equal(fsx._copies.length, 0);
    // forge.yaml backfilled because clone (in this stub) left none.
    assert.ok(fsx._writes.some((w) => w.path === join(TARGET, "forge.yaml")));
  });

  it("falls back to the bundled scaffold when clone fails", async () => {
    const fsx = makeFsx({ present: [SCAFFOLD] });
    const logger = makeLogger();
    const exec = makeExec((cmd, a) => {
      if (cmd === "git" && a[0] === "clone") return { status: 128, stdout: "", stderr: "not found" };
      return { status: 0, stdout: "", stderr: "" };
    });

    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: [],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });

    assert.equal(r.status, "ok");
    assert.equal(r.source, "scaffold");
    // Scaffold copied to target, excluding bootstrap.sh via the filter.
    assert.equal(fsx._copies.length, 1);
    assert.equal(fsx._copies[0].src, SCAFFOLD);
    assert.equal(fsx._copies[0].dest, TARGET);
    // git init + add + commit invoked for local history. (commit is preceded by
    // -c config flags, so match against the full arg list, not just args[0].)
    const gitCalls = exec.calls.filter((c) => c.cmd === "git");
    assert.ok(gitCalls.some((c) => c.args.includes("init")));
    assert.ok(gitCalls.some((c) => c.args.includes("commit")));
  });

  it("errors when clone fails AND no scaffold is present", async () => {
    const fsx = makeFsx(); // scaffold absent
    const logger = makeLogger();
    const exec = makeExec(() => ({ status: 1, stdout: "", stderr: "" }));

    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: [],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });

    assert.equal(r.status, "error");
    assert.match(logger.errtext(), /no bundled scaffold|Could not clone/);
  });

  it("idempotent re-run: existing git clone is fast-forwarded, not re-cloned", async () => {
    const fsx = makeFsx({
      present: [TARGET, join(TARGET, ".git"), join(TARGET, "forge.yaml")],
      dirContents: { [TARGET]: ["src", ".git", "forge.yaml"] },
    });
    const logger = makeLogger();
    const exec = makeExec(() => ({ status: 0, stdout: "Already up to date.", stderr: "" }));

    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: [],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });

    assert.equal(r.status, "ok");
    assert.equal(r.source, "pulled");
    const subs = exec.calls.filter((c) => c.cmd === "git").map((c) => c.args[0]);
    assert.ok(subs.includes("pull"));
    assert.ok(!subs.includes("clone")); // never re-clones
  });

  it("idempotent re-run: existing non-git directory is reused, not clobbered", async () => {
    const fsx = makeFsx({
      present: [TARGET, join(TARGET, "forge.yaml")],
      dirContents: { [TARGET]: ["stuff.txt"] },
    });
    const logger = makeLogger();
    const exec = makeExec(() => ({ status: 0 }));

    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: [],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });

    assert.equal(r.status, "ok");
    assert.equal(r.source, "exists");
    assert.equal(fsx._copies.length, 0);
    assert.ok(!exec.calls.some((c) => c.cmd === "git" && c.args[0] === "clone"));
  });

  it("--open launches claude when available", async () => {
    const fsx = makeFsx({ present: [SCAFFOLD] });
    const logger = makeLogger();
    const exec = makeExec((cmd, a) =>
      cmd === "git" && a[0] === "clone" ? { status: 1 } : { status: 0 },
    );
    const launched = [];

    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: ["--open"],
      exec, fsx, logger, commandExists: (b) => b === "claude",
      launch: (bin, a, opts) => launched.push({ bin, a, opts }),
    });

    assert.equal(r.status, "ok");
    assert.equal(launched.length, 1);
    assert.equal(launched[0].bin, "claude");
    assert.equal(launched[0].opts.cwd, TARGET);
  });

  it("--open without claude on PATH does not launch and prints guidance", async () => {
    const fsx = makeFsx({ present: [SCAFFOLD] });
    const logger = makeLogger();
    const exec = makeExec((cmd, a) =>
      cmd === "git" && a[0] === "clone" ? { status: 1 } : { status: 0 },
    );
    const launched = [];

    await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: ["--open"],
      exec, fsx, logger, commandExists: () => false,
      launch: () => launched.push(1),
    });

    assert.equal(launched.length, 0);
    assert.match(logger.text(), /not found on PATH/);
  });

  it("--help prints usage and does nothing else", async () => {
    const fsx = makeFsx();
    const logger = makeLogger();
    const exec = makeExec();
    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, args: ["--help"],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });
    assert.equal(r.status, "help");
    assert.equal(exec.calls.length, 0);
    assert.match(logger.text(), /Usage: forgedock demo/);
  });

  it("returns an error for a bad flag", async () => {
    const fsx = makeFsx();
    const logger = makeLogger();
    const r = await runDemo({
      forgeHome: FORGE_HOME, home: HOME, args: ["--bogus"],
      exec: makeExec(), fsx, logger, commandExists: () => false, launch: () => {},
    });
    assert.equal(r.status, "error");
    assert.match(logger.errtext(), /Unknown flag/);
  });

  it("custom --repo flows into the clone URL and generated forge.yaml", async () => {
    const fsx = makeFsx({ present: [SCAFFOLD] });
    const logger = makeLogger();
    const exec = makeExec((cmd, a) =>
      cmd === "git" && a[0] === "clone" ? { status: 1 } : { status: 0 },
    );

    await runDemo({
      forgeHome: FORGE_HOME, home: HOME, cwd: "/work", args: ["--repo", "acme/demo"],
      exec, fsx, logger, commandExists: () => false, launch: () => {},
    });

    const cloneCall = exec.calls.find((c) => c.cmd === "git" && c.args[0] === "clone");
    assert.match(cloneCall.args.join(" "), /acme\/demo/);
    const yaml = fsx._writes.find((w) => w.path.endsWith("forge.yaml"));
    assert.match(yaml.data, /owner: "acme"/);
  });
});

describe("constants", () => {
  it("default repo and dirname are stable", () => {
    assert.equal(DEFAULT_DEMO_REPO, "RapierCraftStudios/forgedock-demo");
    assert.equal(DEFAULT_DEMO_DIRNAME, "forgedock-demo");
  });
});
