// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5087: route reachability. A fix that adds an HTTP route handler can pass every test while the production ingress sends
 * the path to another service. forge.yaml `topology.route_reachability` is a repo-supplied command that takes the added
 * route paths as arguments and exits non-zero when the production ingress does not deliver them to the service that
 * implements them. Core stays repo-agnostic (#1347): it only derives the paths and runs the command. Absent key = no check.
 */
import { OUTCOME_CODES } from "../engine/outcome-codes.mjs";

const APP_ROUTE_RE = /(?:^|\/)app\/(?:(.*)\/)?route\.(?:[cm]?[jt]sx?)$/;
const PAGES_API_RE = /(?:^|\/)pages\/(api(?:\/.*)?)\.(?:[cm]?[jt]sx?)$/;

/** URL path of one Next.js route handler file (app router `route.ts`, pages router `pages/api`), or null. Route groups `(x)` and slots `@x` are not URL segments. */
export function routePathOf(file) {
  const f = String(file ?? "").replace(/\\/g, "/");
  const app = APP_ROUTE_RE.exec(f);
  if (app) return `/${(app[1] ?? "").split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/")}`;
  const pg = PAGES_API_RE.exec(f);
  if (pg) return `/${pg[1].replace(/\/index$/, "")}`;
  return null;
}

/** Sorted unique URL paths of the route-handler files in `files`. */
export function routePathsFromFiles(files) {
  return [...new Set((files ?? []).map(routePathOf).filter(Boolean))].sort();
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Blocking failures (conformance.unimplemented, kind route_unreachable) when the declared command exits non-zero for the
 * added route paths. [] when no command is declared or no route was added. A command that cannot start (rc 127) is
 * reported too: a declared blocking check that never ran is no evidence. `run` is ({command}) => {rc, output}
 * (a `{r: {rc, output}}` wrapper is unwrapped).
 */
export async function routeReachabilityFailures({ command, paths, run }) {
  const cmd = typeof command === "string" ? command.trim() : "";
  if (!cmd || !paths?.length) return [];
  let r;
  try { r = await run({ command: `${cmd} ${paths.map(sq).join(" ")}` }); r = r?.r ?? r; } catch (e) { r = { rc: 127, output: String(e?.message ?? e) }; }
  if (r?.rc === 0) return [];
  const tail = String(r?.output ?? "").trim().split("\n").slice(-12).join("\n").slice(0, 1500);
  return [{
    code: OUTCOME_CODES.CONFORMANCE_UNIMPLEMENTED, kind: "route_unreachable",
    detail: `forge.yaml topology.route_reachability (\`${cmd}\`) exited ${r?.rc ?? "?"} for the new route(s) ${paths.join(", ")}: the production ingress does not deliver them to the service that implements them; fix the route or the ingress, citing the ingress rule${tail ? `:\n${tail}` : ""}`,
  }];
}
