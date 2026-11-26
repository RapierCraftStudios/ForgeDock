import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUntil, GH_TRANSIENT_RE as NET_RE } from "./retry.mjs";

test("pollUntil returns the first truthy probe value, sleeping between tries", async () => {
  let n = 0, t = 0; const sleeps = [];
  const v = await pollUntil(() => (++n >= 3 ? "ok" : null), { timeoutMs: 100, pollMs: 7, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t });
  assert.equal(v, "ok"); assert.deepEqual(sleeps, [7, 7]);
});

test("pollUntil returns null once the timeout passes, probing at least once", async () => {
  let t = 0, n = 0;
  const v = await pollUntil(() => { n++; return null; }, { timeoutMs: 20, pollMs: 10, sleep: async (ms) => { t += ms; }, now: () => t });
  assert.equal(v, null); assert.ok(n >= 3);
  assert.equal(await pollUntil(() => null, { timeoutMs: -1, pollMs: 1, sleep: async () => {}, now: () => 0 }), null);
});

test("gh network failures are transient, validation errors are not (2026-11-26: a dropped connection during gh pr merge became an engine-error)", () => {
    for (const t of ["error connecting to api.github.com", "check your internet connection", "dial tcp: lookup api.github.com: no such host", "net/http: TLS handshake timeout", "read tcp: i/o timeout", "connect: connection refused"]) assert.ok(NET_RE.test(t), t);
    for (const t of ["HTTP 422: Validation Failed", "GraphQL: Could not resolve to a PullRequest", "HTTP 404: Not Found"]) assert.ok(!NET_RE.test(t), t);
});
