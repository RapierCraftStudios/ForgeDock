// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppJwt, mintInstallationToken, findInstallation, buildManifest, convertManifestCode, receiveManifestCode, PIPELINE_PERMISSIONS } from "./app-manifest.mjs";
import { authFromCli, resolveAuth, readState, statePath } from "./app-token.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const NOW = Date.parse("2026-01-01T00:00:00Z");

test("App JWT is RS256, verifies, and expires within 10 minutes", () => {
  const jwt = createAppJwt({ appId: 123, pem: privateKey, now: NOW });
  const [h, p, sig] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "RS256");
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "123");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
});

test("local mint is scoped to repository_ids and pipeline permissions", async () => {
  let seen;
  const r = await mintInstallationToken({ appId: 1, pem: privateKey, installationId: 55, repositoryIds: [9], now: NOW,
    fetch: async (url, init) => { seen = { url, init }; return json({ token: "ghs_L", expires_at: "2026-01-01T01:00:00Z" }); } });
  assert.equal(r.token, "ghs_L");
  assert.equal(seen.url, "https://api.github.com/app/installations/55/access_tokens");
  assert.match(seen.init.headers.Authorization, /^Bearer ey/);
  assert.deepEqual(JSON.parse(seen.init.body), { permissions: PIPELINE_PERMISSIONS, repository_ids: [9] });
  await assert.rejects(mintInstallationToken({ appId: 1, pem: privateKey, installationId: 1, fetch: async () => json({}, 401) }), /HTTP 401/);
});

test("findInstallation and manifest conversion", async () => {
  assert.equal(await findInstallation({ appId: 1, pem: privateKey, fetch: async () => json([{ id: 77 }]) }), 77);
  assert.equal(await findInstallation({ appId: 1, pem: privateKey, fetch: async () => json([]) }), null);
  const app = await convertManifestCode({ code: "c/1", fetch: async (u) => { assert.ok(u.endsWith("/app-manifests/c%2F1/conversions")); return json({ id: 5, slug: "mine", pem: "PEM" }); } });
  assert.deepEqual(app, { appId: 5, slug: "mine", pem: "PEM" });
  assert.equal(buildManifest({ redirectUrl: "http://127.0.0.1:1/callback" }).default_permissions.contents, "write");
});

test("loopback receiver returns the code only for the matching state", async () => {
  let base;
  const p = receiveManifestCode({ state: "S1", manifest: (port) => buildManifest({ redirectUrl: `http://127.0.0.1:${port}/callback` }), onListening: (u) => (base = u) });
  while (!base) await new Promise((r) => setTimeout(r, 5));
  const page = await (await fetch(base)).text();
  assert.match(page, /settings\/apps\/new\?state=S1/);
  assert.equal((await fetch(`${base}callback?state=WRONG&code=x`)).status, 400);
  assert.equal((await fetch(`${base}callback?state=S1&code=THECODE`)).status, 200);
  assert.equal(await p, "THECODE");
});

test("auth login --byo end to end: manifest, conversion, PEM 0600, install lookup, local mint on refresh", async () => {
  const env = { FORGE_HOME_DIR: mkdtempSync(join(tmpdir(), "byo-")) };
  const lines = [];
  const fetchFn = async (url, init) => {
    if (url.includes("/app-manifests/")) return json({ id: 5, slug: "mine", pem: privateKey });
    if (url.endsWith("/app/installations")) return json([{ id: 88 }]);
    if (url.endsWith("/access_tokens")) return json({ token: "ghs_BYO", expires_at: new Date(Date.now() + 3600000).toISOString() });
    assert.fail(url);
  };
  const run = authFromCli(["login", "--byo"], { env, fetch: fetchFn, out: (m) => lines.push(m), sleep: async () => {},
    openUrl: async (u) => { const state = (await (await fetch(u)).text()).match(/state=(\w+)/)[1]; await fetch(`${u}callback?state=${state}&code=abc`); } });
  assert.equal(await run, 0);
  const s = readState(env);
  assert.deepEqual([s.mode, s.appId, s.slug, s.installationId], ["byo", 5, "mine", 88]);
  assert.equal(statSync(join(env.FORGE_HOME_DIR, "app-byo.pem")).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(env.FORGE_HOME_DIR, "app-byo.pem"), "utf8"), privateKey);
  assert.equal(statSync(statePath(env)).mode & 0o777, 0o600);
  const r = await resolveAuth({ env, fetch: fetchFn });
  assert.deepEqual([r.source, r.env.GH_TOKEN], ["byo", "ghs_BYO"]);
});
