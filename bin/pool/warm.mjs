// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Warm sandboxes (#4912): the agent keeps N sandboxes per repo started and prepared (checkout at the base ref, dependency
 * cache primed; the image's warm mode, CS_WARM=1). A container's env is fixed at `docker run`, so a claim hands the lane
 * over through a mode-0600 claim file in the mounted /claim dir (lane env, command, ref); the sandbox reads it once,
 * deletes it, refreshes the checkout to the lane's ref with an incremental fetch (warm-refresh.sh) and execs the command.
 * The size comes from the launch spec (`spec.warm`, the lane's `execution.warm_sandboxes`); 0 keeps none.
 * `launch`, `destroy` and `view` are the agent's own, so warm sandboxes are ordinary records (capacity, lease, reaper).
 */
export const MAX_WARM = 8;
const keyOf = (spec) => String(spec?.cache?.key ?? spec?.repo?.slug ?? "default").toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 60);

export function makeWarm({ store, sb, own, now, launch, destroy, view, log = console }) {
  const wanted = () => (store.data.warm ??= {});
  const recs = (key) => Object.values(sb()).filter((r) => r.warm && (key === undefined || r.warm === key));
  const isReady = (r) => r.state === "running" && existsSync(join(r.dir, "out", "warm-ready"));
  /** The pool entry for a launch spec: n warm sandboxes for the spec's repo (0 removes it). */
  function configure({ spec, cpus, mem_gb, limit, n }) {
    const key = keyOf(spec), want = Math.min(MAX_WARM, Number.isInteger(n) ? n : 0);
    if (want <= 0) { delete wanted()[key]; store.save(); return { key, n: 0 }; }
    // An absent limit keeps the stored burst caps; an explicit null clears them.
    wanted()[key] = { n: want, cpus, mem_gb, limit: limit === undefined ? (wanted()[key]?.limit ?? null) : limit, spec: { image: spec.image ?? null, repo: spec.repo ?? null, cache: spec.cache ?? null, docker: Boolean(spec.docker) } };
    store.save();
    return { key, n: want };
  }
  const list = () => recs().map((r) => ({ id: r.id, key: r.warm, state: r.state, ready: isReady(r), cpus: r.cpus, mem_gb: r.mem_gb }));
  /** Start sandboxes until each repo has its n (ready or still preparing). Refused launches (capacity) are retried on the next call. */
  async function replenish() {
    for (const [key, w] of Object.entries(wanted())) {
      for (let have = recs(key).length; have < w.n; have++) {
        const id = `warm-${key}-${randomBytes(3).toString("hex")}`;
        const spec = { id, ...w.spec, env: { CS_WARM: "1" }, command: ["true"], claim_dir: true };
        const r = await launch({ spec, cpus: w.cpus, mem_gb: w.mem_gb, limit: w.limit });
        if (r.status !== 201) break;
        const rec = own(id);
        if (!rec) break;
        if (rec.state === "exited") { await destroy(id, "warm launch failed"); break; }
        rec.warm = key;
        rec.createdWarmAt = now();
        store.save();
      }
    }
  }
  /** Claim a ready warm sandbox of the same repo and size for the lane `spec`; 404 when none is ready. */
  async function claim({ spec, cpus, mem_gb, limit }) {
    if (Number.isInteger(spec?.warm)) configure({ spec, cpus, mem_gb, limit, n: spec.warm });
    const known = own(spec?.id);
    if (known) { known.lease = now(); store.save(); return { status: 200, body: view(known) }; }
    const rec = recs(keyOf(spec)).find((r) => isReady(r) && r.cpus === cpus && r.mem_gb === mem_gb);
    if (!rec) return { status: 404, body: { error: "no warm sandbox ready" } };
    const dir = join(rec.dir, "claim");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, ".claim.tmp");
    writeFileSync(tmp, JSON.stringify({ env: spec.env ?? {}, command: (spec.command ?? []).map(String), ref: spec.repo?.ref ?? null }), { mode: 0o600 });
    renameSync(tmp, join(dir, "claim.json"));
    // The lane id answers for the warm record (the container's baked cred/relay URLs keep the warm id).
    Object.assign(rec, { alias: spec.id, issue: spec.issue ?? null, batch: spec.batch ?? null, result_file: spec.result_file ?? null, startedAt: now(), lease: now() });
    delete rec.warm;
    store.save();
    replenish().catch((e) => log.warn?.(`warm replenish: ${e.message}`));
    return { status: 200, body: view(rec) };
  }
  /** Reaper hook: unclaimed warm sandboxes keep their own lease; dead or over-age ones are replaced. */
  async function maintain(maxLifeMs) {
    for (const r of recs()) {
      if (r.state === "exited") await destroy(r.id, "warm sandbox exited");
      else if (now() - r.createdWarmAt > maxLifeMs) await destroy(r.id, "warm max lifetime");
      else r.lease = now();
    }
    await replenish();
  }
  /** The record answering to a claimed lane id. */
  const byAlias = (id) => (typeof id === "string" ? Object.values(sb()).find((r) => r.alias === id) : undefined);
  return { configure, list, replenish, claim, maintain, byAlias, keyOf };
}
