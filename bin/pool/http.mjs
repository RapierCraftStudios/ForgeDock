// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { timingSafeEqual } from "node:crypto";

export async function readJson(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  if (!size) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid json"), { status: 400 }); }
}

export function send(res, status, data, headers = {}) {
  const body = data === undefined ? "" : typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, { "content-type": typeof data === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(body);
}

export function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? "")), y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** True when the request carries `Authorization: Bearer <token>`. */
export function bearerOk(req, token) {
  const m = /^Bearer\s+(\S.*)$/i.exec(req.headers.authorization ?? "");
  return Boolean(m) && sameSecret(m[1].trim(), token);
}

/** JSON call to another computeshare process; never throws on HTTP status, only on transport failure. */
export async function call(base, method, path, { body, token, timeoutMs = 15000, fetchFn = globalThis.fetch } = {}) {
  const res = await fetchFn(`${String(base).replace(/\/+$/, "")}${path}`, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data, retryAfter: res.headers.get("retry-after") };
}

export function route(method, pattern) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`);
  return (req, url) => {
    if (req.method !== method) return null;
    const m = re.exec(url.pathname);
    return m ? Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) : null;
  };
}
