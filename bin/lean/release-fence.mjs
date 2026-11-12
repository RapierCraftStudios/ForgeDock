// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lease-epoch fencing (#5553, epic #5549 Phase 0, invariants I5/I7): every irreversible release action (merge, workflow
 * dispatch, rerun, rollback, flag flip, intake release) re-reads `forge-ledger/_active`, aborts unless the lease is still this
 * driver's epoch, records a write-ahead intent naming the epoch, re-checks immediately before acting, and hands the epoch to
 * the effect so it travels with the action (`Forge-Epoch` merge trailer, `forge_epoch` dispatch input, comment marker).
 * A host that cannot read `_active` performs nothing. Without a fence (unmanaged release) the effect just runs.
 */
import { readActive } from "./release-ledger.mjs";

export const epochTrailer = (epoch) => `Forge-Epoch: ${epoch}`;
export const epochMarker = (epoch) => `<!-- FORGE:EPOCH ${epoch} -->`;

/** @returns {{ok: true, epoch} | {fenced: true, current} | {unreadable: string}} */
export async function fenceCheck(ctx, lease) {
  let active;
  try { active = await readActive(ctx); } catch (e) { return { unreadable: String(e?.message ?? e) }; }
  if (active?.lease?.holder !== lease.holder || active?.lease?.epoch !== lease.epoch) return { fenced: true, current: active?.epoch ?? null };
  return { ok: true, epoch: lease.epoch };
}

const refusal = (c, lease) => (c.unreadable ? `refused: cannot read _active (${c.unreadable})` : `refused: fenced (epoch ${lease.epoch} is not current, ${c.current ?? "unknown"} is)`);

/**
 * Run `effect(epoch)` only while `fence` ({lctx, lease, record, now}) is the current lease. `record` persists the intent before
 * the effect (and its completion after). No fence: `effect(null)`.
 * @returns {{ok: true, value} | {refused: string}} an effect error propagates
 */
export async function fenced(fence, { action, key }, effect) {
  if (!fence) return { ok: true, value: await effect(null) };
  const { lctx, lease } = fence;
  let c = await fenceCheck(lctx, lease);
  if (!c.ok) return { refused: refusal(c, lease) };
  const intent = { key, action, epoch: lease.epoch, holder: lease.holder, at: fence.now() };
  await fence.record(intent);
  c = await fenceCheck(lctx, lease); // the window between the first read and the intent write is where a takeover can slip in
  if (!c.ok) return { refused: refusal(c, lease) };
  const value = await effect(lease.epoch);
  await fence.record({ ...intent, done: true });
  return { ok: true, value };
}
