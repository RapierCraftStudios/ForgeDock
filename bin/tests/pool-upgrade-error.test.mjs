// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// #5919: a failed lane-image build reports the failing command's own output, and a network failure is retried once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upgradeErrorText, buildWithRetry, NETWORK_BUILD_RE } from "../pool/agent.mjs";

const ECHO = `Dockerfile:32\n--------------------\n  32 | >>> RUN curl -fsSL "https://nodejs.org/dist/v\${NODE_VERSION}/node.tar.xz" | tar -xJ -C /opt \\\n  34 | >>>     && npm install -g "corepack@\${COREPACK_VERSION}" "forgedock@\${FORGEDOCK_VERSION}" \\\n--------------------\n`.repeat(3);
const buildError = (cause) => Object.assign(new Error("docker build failed"), { stderr: `${ECHO}#7 12.3 ${cause}\nERROR: failed to build: failed to solve: process "/bin/sh -c curl ..." did not complete successfully: exit code: 1` });

describe("upgrade error text (#5919)", () => {
  it("keeps the tail, so the failing command's own output survives a long Dockerfile echo", () => {
    const t = upgradeErrorText(buildError("npm error code ETIMEDOUT"));
    assert.ok(t.length <= 2000);
    assert.match(t, /npm error code ETIMEDOUT/);
    assert.match(t, /did not complete successfully: exit code: 1/);
    // the 1.61.2 behaviour: the first 500 characters are only the echo
    assert.doesNotMatch(String(buildError("npm error code ETIMEDOUT").stderr).slice(0, 500), /ETIMEDOUT/);
  });
  it("short errors are returned whole", () => {
    assert.equal(upgradeErrorText(new Error("bundle download: HTTP 502")), "bundle download: HTTP 502");
  });
});

describe("buildWithRetry (#5919)", () => {
  it("retries once on a network failure and succeeds", async () => {
    let n = 0;
    const r = await buildWithRetry(async () => { if (n++ === 0) throw buildError("curl: (28) Operation timed out after 300000 milliseconds"); return "ok"; }, { sleep: async () => {} });
    assert.equal(r, "ok"); assert.equal(n, 2);
  });
  it("does not retry a non-network failure (bad version pin)", async () => {
    let n = 0;
    await assert.rejects(buildWithRetry(async () => { n++; throw buildError("npm error code ETARGET\nnpm error notarget No matching version found for forgedock@9.9.9"); }, { sleep: async () => {} }), /docker build failed/);
    assert.equal(n, 1);
  });
  it("a second network failure is reported, not retried again", async () => {
    let n = 0;
    await assert.rejects(buildWithRetry(async () => { n++; throw buildError("npm error code ECONNRESET"); }, { sleep: async () => {} }));
    assert.equal(n, 2);
  });
  it("classifies network signatures", () => {
    for (const s of ["curl: (6) Could not resolve host: nodejs.org", "npm error code EAI_AGAIN", "dial tcp: i/o timeout", "502 Bad Gateway"]) assert.match(s, NETWORK_BUILD_RE, s);
    for (const s of ["npm error code ETARGET", "No matching version found for forgedock@9.9.9", "exit code: 127"]) assert.doesNotMatch(s, NETWORK_BUILD_RE, s);
  });
});
