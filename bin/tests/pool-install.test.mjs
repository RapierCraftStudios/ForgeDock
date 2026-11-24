// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5883: one-command installers (GET /install), Linux and macOS install/uninstall scripts, `pool enroll` one-liner.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "../pool/router.mjs";
import { poolFromCli } from "../engine-cli.mjs";
import { tmpDir } from "./_tmp.mjs";

const installDir = fileURLToPath(new URL("../../pool/install/", import.meta.url)).replace(/\\/g, "/");
const quiet = { info() {}, warn() {}, error() {} };

function router() {
  return createRouter({ state_dir: tmpDir("pool-install-"), enroll_token: "ENROLL-SECRET", forgedock_token: "FD-SECRET", repos: {}, public_url: "http://100.9.9.9:7710" }, { log: quiet });
}
const get = (r, url, headers = {}) => new Promise((resolve) => {
  const res = { writeHead(s, h) { this.s = s; this.h = h; }, setHeader() {}, end(b) { resolve({ status: this.s, headers: this.h ?? {}, body: String(b ?? "") }); } };
  r.handle({ method: "GET", url, headers, socket: {} }, res);
});

describe("GET /install (#5883)", () => {
  it("serves a text/plain POSIX sh script without auth, baking the router URL and no secret", async () => {
    const r = router();
    const { code } = r.issueCode();
    const out = await get(r, "/install");
    assert.equal(out.status, 200);
    assert.match(out.headers["content-type"], /^text\/plain/);
    assert.match(out.body, /^#!\/bin\/sh\n/);
    assert.match(out.body, /^ROUTER='http:\/\/100\.9\.9\.9:7710'$/m);
    assert.doesNotMatch(out.body, /ENROLL-SECRET|FD-SECRET/);
    assert.ok(!out.body.includes(code), "an issued one-time code never appears in the script");
    assert.match(out.body, /bootstrap\/bundle\.tar\.gz\?token=\$CODE/);
    assert.match(out.body, /install-agent-\$OS\.sh" "\$@" --token "\$CODE" --bundle/);
    assert.match(out.body, /--router "\$ROUTER" --outbound/);
    const f = join(tmpDir("pool-install-sh-"), "install.sh");
    writeFileSync(f, out.body);
    assert.equal(spawnSync("sh", ["-n", f]).status, 0);
    // The code stays usable for the bundle (checked, not consumed by serving the script).
    assert.equal((await get(r, `/bootstrap/install.ps1?token=${code}`)).status, 200);
  });

  it("parses --code/--name/--cpus/--mem/--uninstall and redacts the code in --dry-run", async () => {
    const f = join(tmpDir("pool-install-sh-"), "install.sh");
    writeFileSync(f, (await get(router(), "/install")).body);
    const sh = (...a) => spawnSync("sh", [f, ...a], { encoding: "utf8" });
    const inst = sh("--dry-run", "--code", "C0DE-xyz", "--name", "box", "--cpus", "3", "--mem", "6");
    assert.equal(inst.status, 0, inst.stderr);
    assert.match(inst.stdout, /^os=linux action=(install|reinstall) router=http:\/\/100\.9\.9\.9:7710 root=\/opt\/computeshare name=box cpus=3 mem_gb=6 code=<redacted>$/m);
    assert.ok(!inst.stdout.includes("C0DE-xyz"));
    assert.match(sh("--dry-run", "--uninstall").stdout, /action=uninstall/);
    assert.equal(sh("--bogus").status, 2);
  });

  it("an unquoted quote in public_url cannot break out of the sh string", async () => {
    const r = createRouter({ state_dir: tmpDir("pool-install-"), enroll_token: "e", forgedock_token: "fd", repos: {}, public_url: "http://x'$(id)" }, { log: quiet });
    const body = (await get(r, "/install")).body;
    assert.match(body, /^ROUTER='http:\/\/x'\\''\$\(id\)'$/m);
  });
});

describe("installer scripts (#5883)", () => {
  it("every Linux and macOS install/uninstall script parses", () => {
    for (const f of ["install-agent.sh", "install-agent-linux.sh", "uninstall-agent-linux.sh", "install-agent-macos.sh", "uninstall-agent-macos.sh"]) {
      const r = spawnSync("bash", ["-n", `${installDir}${f}`], { encoding: "utf8" });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  });

  it("install-agent.sh records what it added in the installed-by marker; linux reruns reuse the installed code", () => {
    const sh = readFileSync(`${installDir}install-agent.sh`, "utf8");
    for (const m of ["docker", "node", "sysctl"]) assert.match(sh, new RegExp(`\\n\\s+mark ${m}\\n`), m);
    assert.match(sh, /MARKER=\/etc\/computeshare\/installed-by/);
    const linux = readFileSync(`${installDir}install-agent-linux.sh`, "utf8");
    assert.match(linux, /agent\.token \] && \[ -f \/opt\/computeshare\/package\.json \]; then[\s\S]*tar -czf "\$BUNDLE" -C \/opt\/computeshare \./);
    assert.match(linux, /is-enabled fstrim\.timer[\s\S]*echo fstrim\.timer >> \/etc\/computeshare\/installed-by/);
  });

  it("macOS installer --dry-run resolves settings and redacts the token", () => {
    const r = spawnSync("bash", [`${installDir}install-agent-macos.sh`, "--dry-run", "--outbound", "--router", "http://100.1.1.1:7710", "--token", "sekret", "--name", "Mac1", "--cpus", "4", "--mem", "8"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /router=http:\/\/100\.1\.1\.1:7710 name=mac1 url= port=7711 cpus=4 mem_gb=8 bundle=<download> root=\/usr\/local\/computeshare/);
    assert.ok(!r.stdout.includes("sekret"));
    assert.match(readFileSync(`${installDir}install-agent-macos.sh`, "utf8"), /io\.forgedock\.computeshare-agent/);
  });
});

/** A scratch host: CS_PREFIX root, stub systemctl/launchctl/docker on PATH recording calls, docker state in files. */
function fakeHost() {
  const dir = tmpDir("pool-uninstall-");
  const root = join(dir, "root"), bin = join(dir, "bin"), log = join(dir, "calls.log");
  mkdirSync(bin, { recursive: true });
  // containers.txt / volumes.txt: "<name> <comma-separated labels>"; images.txt: "<repo>:<tag>"
  writeFileSync(join(dir, "containers.txt"), [
    "cs-lane1 computeshare=1,computeshare.agent=box",
    "cs-lane1-dind computeshare=1,computeshare.agent=box",
    "cs-other computeshare=1,computeshare.agent=otherbox",
    "postgres app=primary",
  ].join("\n") + "\n");
  writeFileSync(join(dir, "volumes.txt"), ["cs-cache-x computeshare.agent=box", "cs-work-y computeshare.agent=box", "cs-cache-z computeshare.agent=otherbox", "pgdata app=primary"].join("\n") + "\n");
  writeFileSync(join(dir, "images.txt"), ["forgedock-lane:1.2.3", "forgedock-lane:1.2.3-tabc", "postgres:16"].join("\n") + "\n");
  const stub = (name, body) => { const f = join(bin, name); writeFileSync(f, `#!/usr/bin/env bash\necho "${name} $*" >> '${log}'\n${body}\n`); chmodSync(f, 0o755); };
  stub("systemctl", "exit 0");
  stub("launchctl", "exit 0");
  stub("sysctl", "exit 0");
  stub("apt-get", "exit 0");
  stub("docker", `D='${dir}'
label=""; for a in "$@"; do case "$a" in label=*) label="\${a#label=}" ;; esac; done
case "$1 $2" in
  "info "*) exit 0 ;;
  "ps -a") awk -v l="$label" '{ n=split($2,a,","); for(i=1;i<=n;i++) if(a[i]==l) print $1 }' "$D/containers.txt" ;;
  "volume ls") awk -v l="$label" '{ n=split($2,a,","); for(i=1;i<=n;i++) if(a[i]==l) print $1 }' "$D/volumes.txt" ;;
  "volume rm") n="\${@: -1}"; awk -v n="$n" '$1!=n' "$D/volumes.txt" > "$D/v.tmp" && mv "$D/v.tmp" "$D/volumes.txt" ;;
  "image ls") grep '^forgedock-lane:' "$D/images.txt" || true ;;
  "image rm") n="\${@: -1}"; grep -vx "$n" "$D/images.txt" > "$D/i.tmp"; mv "$D/i.tmp" "$D/images.txt" ;;
  "rm -f") n="\${@: -1}"; awk -v n="$n" '$1!=n' "$D/containers.txt" > "$D/c.tmp" && mv "$D/c.tmp" "$D/containers.txt" ;;
esac
exit 0`);
  const put = (rel, text = "x") => { const f = join(root, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, text); };
  const run = (script, ...args) => spawnSync("bash", [`${installDir}${script}`, ...args], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CS_PREFIX: root } });
  const lines = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { root, put, run, lines, calls };
}

describe("uninstall-agent-linux.sh (#5883)", () => {
  const install = (h, marker) => {
    h.put("etc/systemd/system/computeshare-agent.service", "[Unit]\n");
    h.put("etc/computeshare/agent.json", JSON.stringify({ name: "Box", listen: { host: "172.17.0.1", port: 7711 } }, null, 2));
    h.put("etc/computeshare/agent.token", "tok\n");
    if (marker !== null) h.put("etc/computeshare/installed-by", marker);
    h.put("opt/computeshare/package.json", "{}");
    h.put("opt/node/bin/node", "");
    h.put("var/lib/computeshare/agent-state.json", "{}");
    h.put("etc/sysctl.d/90-computeshare-noipv6.conf", "net.ipv6.conf.all.disable_ipv6=1\n");
  };

  it("removes the unit, dirs and only this agent's containers, volumes and lane images", () => {
    const h = fakeHost();
    install(h, "node\nfstrim.timer\n");
    const r = h.run("uninstall-agent-linux.sh");
    assert.equal(r.status, 0, r.stderr);
    for (const p of ["etc/systemd/system/computeshare-agent.service", "etc/computeshare", "opt/computeshare", "var/lib/computeshare", "opt/node", "etc/sysctl.d/90-computeshare-noipv6.conf"]) {
      assert.ok(!existsSync(join(h.root, p)), `${p} removed`);
    }
    assert.deepEqual(h.lines("containers.txt"), ["cs-other", "postgres"]);
    assert.deepEqual(h.lines("volumes.txt"), ["cs-cache-z", "pgdata"]);
    assert.deepEqual(h.lines("images.txt"), ["postgres:16"]);
    const calls = h.calls();
    assert.match(calls, /systemctl disable --now computeshare-agent\.service/);
    assert.match(calls, /systemctl daemon-reload/);
    assert.match(calls, /systemctl disable --now fstrim\.timer/);
    assert.doesNotMatch(calls, /system prune|docker\.service|apt-get purge/, "docker stays: the marker does not list it");
  });

  it("leaves node, fstrim.timer and docker alone without a marker for them", () => {
    const h = fakeHost();
    install(h, null);
    assert.equal(h.run("uninstall-agent-linux.sh").status, 0);
    assert.ok(existsSync(join(h.root, "opt/node/bin/node")));
    assert.doesNotMatch(h.calls(), /fstrim|apt-get|docker\.service/);
  });

  it("removes docker only when the marker says the installer added it", () => {
    const h = fakeHost();
    install(h, "docker\n");
    h.put("etc/apt/sources.list.d/docker.list", "deb x");
    assert.equal(h.run("uninstall-agent-linux.sh").status, 0);
    assert.match(h.calls(), /apt-get purge -y -qq docker-ce docker-ce-cli containerd\.io/);
    assert.ok(!existsSync(join(h.root, "etc/apt/sources.list.d/docker.list")));
  });

  it("--dry-run prints the plan and changes nothing; a rerun on a clean host is a no-op", () => {
    const h = fakeHost();
    install(h, "node\n");
    const dry = h.run("uninstall-agent-linux.sh", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would run: docker rm -f -v cs-lane1\n/);
    assert.match(dry.stdout, /would remove: .*\/opt\/computeshare\n/);
    assert.ok(existsSync(join(h.root, "opt/computeshare/package.json")));
    assert.equal(h.lines("containers.txt").length, 4);
    assert.equal(h.run("uninstall-agent-linux.sh").status, 0);
    const again = h.run("uninstall-agent-linux.sh");
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /removed /);
    assert.deepEqual(h.lines("containers.txt"), ["cs-other", "postgres"]);
  });
});

describe("uninstall-agent-macos.sh (#5883)", () => {
  it("boots out the LaunchDaemon and removes files and this agent's docker objects; idempotent", () => {
    const h = fakeHost();
    h.put("Library/LaunchDaemons/io.forgedock.computeshare-agent.plist", "<key>DOCKER_HOST</key><string>unix:///Users/me/.colima/default/docker.sock</string>\n");
    h.put("usr/local/etc/computeshare/agent.json", JSON.stringify({ name: "box", outbound: true }, null, 2));
    h.put("usr/local/computeshare/node/bin/node", "");
    h.put("usr/local/var/computeshare/agent.log", "");
    const r = h.run("uninstall-agent-macos.sh");
    assert.equal(r.status, 0, r.stderr);
    for (const p of ["Library/LaunchDaemons/io.forgedock.computeshare-agent.plist", "usr/local/computeshare", "usr/local/etc/computeshare", "usr/local/var/computeshare"]) {
      assert.ok(!existsSync(join(h.root, p)), `${p} removed`);
    }
    assert.match(h.calls(), /launchctl bootout system\/io\.forgedock\.computeshare-agent/);
    assert.deepEqual(h.lines("containers.txt"), ["cs-other", "postgres"]);
    assert.deepEqual(h.lines("volumes.txt"), ["cs-cache-z", "pgdata"]);
    const again = h.run("uninstall-agent-macos.sh");
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /removed /);
  });
});

describe("forgedock pool enroll one-liner (#5883)", () => {
  const setup = () => {
    const dir = tmpDir("pool-install-cli-");
    writeFileSync(join(dir, "forgedock.token"), "FD-SECRET\n");
    writeFileSync(join(dir, "enroll.token"), "ENROLL-SECRET\n");
    const config = join(dir, "router.json");
    writeFileSync(config, JSON.stringify({ listen: { host: "100.1.2.3", port: 7710 }, public_url: "http://100.1.2.3:7710", enroll_token_file: join(dir, "enroll.token") }));
    return config;
  };
  const run = async (argv) => {
    const out = [], err = [], log = console.log, error = console.error;
    console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
    try { await poolFromCli([...argv, "--config", setup()], { poolDeps: { call: async () => ({ ok: true, status: 200, data: { code: "ONECODE", expires_at: "soon" } }) } }); }
    finally { console.log = log; console.error = error; }
    return { out: out.join("\n"), err: err.join("\n") };
  };

  it("--outbound prints the curl | sh form first and keeps the OUTBOUND env form", async () => {
    const { out, err } = await run(["enroll", "--outbound", "--cpus", "4", "--mem", "8"]);
    const lines = out.split("\n");
    assert.equal(lines[0], "curl -fsSL 'http://100.1.2.3:7710/install' | sh -s -- --code 'ONECODE' --cpus 4 --mem 8");
    assert.equal(lines[1], "OUTBOUND=1 pool/install/install-agent-linux.sh --router 'http://100.1.2.3:7710' --token 'ONECODE' --cpus 4 --mem 8");
    assert.doesNotMatch(out + err, /ENROLL-SECRET|FD-SECRET/);
  });

  it("--one-liner prints only the curl | sh form; the default stays PowerShell", async () => {
    assert.equal((await run(["enroll", "--one-liner"])).out, "curl -fsSL 'http://100.1.2.3:7710/install' | sh -s -- --code 'ONECODE'");
    assert.match((await run(["enroll"])).out, /^powershell .*install\.ps1\?token=ONECODE/);
  });
});
