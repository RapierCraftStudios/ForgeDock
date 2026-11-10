// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5331: the best known result per validate id. A resumed lane used to see only the newest record, so a remote "exit 127"
 * (the sandbox lacks the tool) hid an earlier local pass and the recovery lane re-verified from scratch. Pure, never throws.
 */
const MISSING_EXITS = new Set([126, 127]); // command not executable / not found: the environment, not the change

export const isToolMissingExit = (exit) => MISSING_EXITS.has(Number(exit));

/**
 * Rows oldest to newest: `{id?, command, exit, where?, head?}`. Returns one row per id (command when no id): a later row
 * replaces an earlier one, except a tool-missing row never replaces a pass.
 */
export function bestResults(rows) {
  const best = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.command !== "string" || !Number.isInteger(r.exit)) continue;
    const key = r.id || r.command;
    const old = best.get(key);
    if (old && old.exit === 0 && isToolMissingExit(r.exit)) continue;
    best.set(key, { id: r.id ?? null, command: r.command, exit: r.exit, where: r.where ?? null, head: r.head ?? null });
  }
  return [...best.values()];
}

/** True when the row passed on `head`; both heads must be known (a row with no recorded head is never "the same head"). */
export const passedOnHead = (row, head) => row?.exit === 0 && !!row.head && !!head && row.head === head;
