// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forge#5131: a daemon-hosted batch on provider `remote` resolves `token_env` (COMPUTESHARE_TOKEN) from the daemon's
 * process.env, end to end through runBatch -> providerByName -> remoteTransportFor -> httpTransport (only fetch is faked).
 * Before the fix the client's empty pin of the token_env passthrough overrode the daemon's token, and the router saw no bearer.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch } from "../engine-cli.mjs";
import { parseExecution } from "../lean/execution.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** Run a fresh daemon-hosted batch with `clientEnv`; resolves with the first router request's headers, then cancels the batch. */
async function firstRouterRequest(clientEnv) {
  const work = mkdtempSync(join(tmpdir(), "remote-token-5131-"));
  dirs.push(work);
  const stub = join(work, "stub-lane.mjs");
  writeFileSync(stub, "setTimeout(() => process.exit(0), 50);\n");
  // The repo pins token_env, so the client's pin passes COMPUTESHARE_TOKEN through (engine-cli readPinnedEnvConfig).
  writeFileSync(join(work, "forge.yaml"), "execution:\n  mode: remote\n  max_remote: 1\n  provider: remote\n  endpoint: http://127.0.0.1:7710\n  token_env: COMPUTESHARE_TOKEN\n");
  const ac = new AbortController();
  const seen = [];
  const sandboxFetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
    ac.abort();
    return new Response(JSON.stringify({ error: "test router" }), { status: 503, headers: { "content-type": "application/json" } });
  };
  const deps = {
    allowTmpfs: true, batchRoot: join(work, "batches"), laneScript: stub, pollMs: 20, preflight: null, sandboxFetch,
    orchestration: { breaker: null, maxDeferrals: 3 },
    execution: parseExecution({ mode: "remote", max_remote: "1", provider: "remote", endpoint: "http://127.0.0.1:7710", token_env: "COMPUTESHARE_TOKEN" }),
    io: { gh: async () => "o/r\n" },
    leanIo: { gh: async (a) => (a.includes("milestone") ? JSON.stringify({ milestone: null }) : a[0] === "repo" ? "main\n" : JSON.stringify({ body: "", labels: [] })),
      git: async (a) => (a[0] === "ls-remote" ? "abc\trefs/heads/staging\n" : "") },
  };
  const sink = { batch: () => {}, row: () => {}, line: () => {} };
  const run = runBatch({ argv: ["1", "--repo", "o/r"], cwd: work, env: clientEnv, sink, deps, daemon: true, signal: ac.signal }).catch((e) => e);
  const deadline = Date.now() + 20000;
  while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await Promise.race([run, new Promise((r) => setTimeout(r, 5000))]);
  return seen[0] ?? null;
}

describe("daemon-hosted remote batch token (#5131)", () => {
  const prev = process.env.COMPUTESHARE_TOKEN;
  after(() => { if (prev === undefined) delete process.env.COMPUTESHARE_TOKEN; else process.env.COMPUTESHARE_TOKEN = prev; });
  const client = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "COMPUTESHARE_TOKEN" && !/TOKEN|SECRET|KEY/i.test(k)));

  for (const [name, env] of [["a client env without secrets", () => client()], ["a client env pinning COMPUTESHARE_TOKEN as empty", () => ({ ...client(), COMPUTESHARE_TOKEN: "" })]]) {
    it(`5131: sends the daemon's COMPUTESHARE_TOKEN as the bearer for ${name}`, async () => {
      process.env.COMPUTESHARE_TOKEN = "daemon-tok";
      const req = await firstRouterRequest(env());
      assert.ok(req, "the batch made no router request");
      assert.ok(req.url.startsWith("http://127.0.0.1:7710"), req.url);
      assert.equal(req.headers.authorization, "Bearer daemon-tok");
    });
  }
});
