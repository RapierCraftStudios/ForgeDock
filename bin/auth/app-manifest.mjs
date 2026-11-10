// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bring-your-own GitHub App (#5301): GitHub's App manifest flow, then local minting of installation tokens with the
 * App's own private key (RS256 JWT via node:crypto; no dependency). Every network call goes through an injected `fetch`.
 */
import { createSign } from "node:crypto";
import { createServer } from "node:http";

export const API = "https://api.github.com";

/** The permissions the pipeline uses; installation tokens are scoped down to exactly these. */
export const PIPELINE_PERMISSIONS = Object.freeze({
  contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", actions: "read", workflows: "write", metadata: "read",
});

const b64u = (b) => Buffer.from(b).toString("base64url");

/** RS256 App JWT: `iat` backdated 60 s for clock skew, `exp` under GitHub's 10 min cap. */
export function createAppJwt({ appId, pem, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const head = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }))}`;
  return `${head}.${createSign("RSA-SHA256").update(head).sign(pem).toString("base64url")}`;
}

async function ghJson(fetchFn, url, init, what) {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new Error(`${what} failed (HTTP ${res.status})`);
  return res.json();
}

const appHeaders = (jwt) => ({ Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "forgedock" });

/** Mint an installation token locally, scoped to `repositoryIds` (when given) and `permissions`. @returns {{token:string, expiresAt:string}} */
export async function mintInstallationToken({ appId, pem, installationId, repositoryIds, permissions = PIPELINE_PERMISSIONS, fetch: fetchFn = fetch, now = Date.now() }) {
  const body = { permissions };
  if (repositoryIds?.length) body.repository_ids = repositoryIds;
  const j = await ghJson(fetchFn, `${API}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: appHeaders(createAppJwt({ appId, pem, now })), body: JSON.stringify(body) }, "installation token mint");
  if (!j?.token || !j?.expires_at) throw new Error("installation token mint returned no token");
  return { token: j.token, expiresAt: j.expires_at };
}

/** First installation of the App (for the BYO owner), via the App JWT. */
export async function findInstallation({ appId, pem, fetch: fetchFn = fetch, now = Date.now() }) {
  const list = await ghJson(fetchFn, `${API}/app/installations`, { headers: appHeaders(createAppJwt({ appId, pem, now })) }, "installation lookup");
  return Array.isArray(list) && list[0]?.id ? list[0].id : null;
}

export function buildManifest({ redirectUrl, name = "forgedock-self-hosted" }) {
  return {
    name, url: "https://github.com/RapierCraftStudios/forgedock", redirect_url: redirectUrl, public: false,
    default_permissions: { ...PIPELINE_PERMISSIONS }, default_events: [],
  };
}

/** POST /app-manifests/{code}/conversions: the App id, slug and private key GitHub generated for the user. */
export async function convertManifestCode({ code, fetch: fetchFn = fetch }) {
  const j = await ghJson(fetchFn, `${API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: "POST", headers: { Accept: "application/vnd.github+json", "User-Agent": "forgedock" } }, "manifest conversion");
  if (!j?.id || !j?.pem) throw new Error("manifest conversion returned no app id or key");
  return { appId: j.id, slug: j.slug, pem: j.pem };
}

/**
 * Loopback receiver: serves an auto-submitting form that posts the manifest to GitHub, then resolves with the `code`
 * GitHub redirects back with (state-checked). `manifest` may be a function of the bound port (for `redirect_url`). `onListening(url)` hands the start URL to the caller (open or print).
 */
export function receiveManifestCode({ manifest, state, onListening, timeoutMs = 300000, org }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); server.close(); fn(v); };
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/callback") {
        const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" }).end(ok ? "ForgeDock: App created, you can close this tab." : "bad state");
        return ok ? finish(resolve, u.searchParams.get("code")) : undefined;
      }
      const target = `https://github.com/${org ? `organizations/${encodeURIComponent(org)}/` : ""}settings/apps/new?state=${state}`;
      const esc = JSON.stringify(typeof manifest === "function" ? manifest(server.address().port) : manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        `<form id=f method=post action="${target}"><input type=hidden name=manifest value="${esc}"></form><script>f.submit()</script>`);
    });
    const timer = setTimeout(() => finish(reject, new Error("manifest flow timed out")), timeoutMs);
    server.on("error", (e) => finish(reject, e));
    server.listen(0, "127.0.0.1", () => onListening?.(`http://127.0.0.1:${server.address().port}/`, server.address().port));
  });
}
