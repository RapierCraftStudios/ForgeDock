// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5331: a remote target that cannot run a frozen validate command is found before the builder implements, not at the
 * validate step. Pure, never throws. `toolMisses` filters the validate preflight's misses (run where the lane runs) to the
 * tools a different placement could supply; `lackedTools` names the contract's tools a target is known to lack.
 */
import { preflightProbes, declaredEnv } from "./preflight.mjs";

const TOOL_KINDS = new Set(["command", "python-module", "node-module"]);

/** `{tools, ids}` from preflight misses: executables and modules, never an unset env var (no placement fixes that). */
export function toolMisses(misses) {
  const tools = new Set(), ids = new Set();
  for (const m of Array.isArray(misses) ? misses : []) {
    if (!m || !TOOL_KINDS.has(m.kind) || !m.tool) continue;
    tools.add(String(m.tool));
    for (const id of Array.isArray(m.ids) ? m.ids : []) ids.add(String(id));
  }
  return { tools: [...tools].sort(), ids: [...ids].sort() };
}

/** `{tools, ids}`: tools the contract's validate/repro commands name that are in `lacks` (names a target is known to miss). */
export function lackedTools(contract, lacks) {
  const lack = new Set((Array.isArray(lacks) ? lacks : lacks ? [...lacks] : []).map(String));
  if (!lack.size || !contract || typeof contract !== "object") return { tools: [], ids: [] };
  try {
    const declared = declaredEnv(contract).filter((t) => lack.has(t)).map((tool) => ({ kind: "command", tool, ids: ["test_plan.env"] })); // #5447
    return toolMisses([...preflightProbes(contract, { cap: 1000 }).probes.filter((p) => lack.has(p.tool)), ...declared]);
  } catch { return { tools: [], ids: [] }; }
}
