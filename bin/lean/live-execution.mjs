// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live execution control of a running batch (#5138): `forgedock orchestrate --set-max-remote <id> N` and
 * `--set-placement <id> remote|hybrid|local`, like `--set-parallel` for K. The override lives in the batch's `execution`
 * file (batch.mjs `readExecution`/`setExecution`, JSON `{maxRemote?, mode?, provider?}`); the runner re-reads it on every
 * admission through the getters `liveRemote` puts on the `remote` object orchestrate gets (`max`, `fallbackLocal`, `place`).
 * Running lanes are never stopped: a lower `max_remote` only holds new remote admissions. A batch that started without a
 * remote provider (`provider` not true: mode local, or `max_remote` 0) refuses `remote`/`hybrid`, since its provider,
 * ledger and execution budget are built once at start; start a new batch for that.
 */

export const LIVE_MODES = Object.freeze(["remote", "hybrid", "local"]);
const LIGHT_WEIGHT = Object.freeze({ heavy: false, signals: [] });

/** Validate a patch `{maxRemote?, mode?, provider?}`; throws on a bad value. @returns the cleaned patch. */
export function validateExecutionPatch(patch = {}) {
  const out = {};
  if (patch.maxRemote !== undefined) {
    const n = typeof patch.maxRemote === "string" && /^\d+$/.test(patch.maxRemote.trim()) ? parseInt(patch.maxRemote, 10) : patch.maxRemote;
    if (!Number.isInteger(n) || n < 0) throw new Error("max_remote must be a non-negative integer");
    out.maxRemote = n;
  }
  if (patch.mode !== undefined) {
    if (!LIVE_MODES.includes(patch.mode)) throw new Error(`placement must be one of ${LIVE_MODES.join("|")}`);
    out.mode = patch.mode;
  }
  if (patch.provider !== undefined) {
    if (typeof patch.provider !== "boolean") throw new Error("provider must be a boolean");
    out.provider = patch.provider;
  }
  return out;
}

/** The fields of a stored override that are valid (anything else is dropped); null when there is none. */
export function sanitizeOverride(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const out = {};
  if (Number.isInteger(o.maxRemote) && o.maxRemote >= 0) out.maxRemote = o.maxRemote;
  if (LIVE_MODES.includes(o.mode)) out.mode = o.mode;
  if (typeof o.provider === "boolean") out.provider = o.provider;
  return out;
}

/** The pinned forge.yaml `exec` with the live override's `maxRemote` and `mode` applied. */
export function effectiveExecution(exec, override) {
  const o = sanitizeOverride(override) ?? {};
  return { ...(exec ?? {}), ...(o.maxRemote !== undefined ? { maxRemote: o.maxRemote } : {}), ...(o.mode !== undefined ? { mode: o.mode } : {}) };
}

/**
 * `--set-max-remote <id> N` / `--set-placement <id> MODE` in argv → `{id, patch}`, or null when neither flag is there.
 * Throws on a missing id or a bad value.
 */
export function parseSetExecution(argv = []) {
  const at = (flag) => argv.indexOf(flag);
  let id = null;
  const patch = {};
  for (const [flag, key] of [["--set-max-remote", "maxRemote"], ["--set-placement", "mode"]]) {
    const i = at(flag);
    if (i < 0) continue;
    const bid = argv[i + 1], val = argv[i + 2];
    if (!bid || val === undefined) throw new Error(`usage: forgedock orchestrate ${flag} <id> ${key === "mode" ? LIVE_MODES.join("|") : "N"}`);
    if (id !== null && id !== bid) throw new Error("--set-max-remote and --set-placement must name the same batch");
    id = bid;
    patch[key] = key === "maxRemote" ? (/^\d+$/.test(val) ? parseInt(val, 10) : NaN) : val;
  }
  return id === null ? null : { id, patch: validateExecutionPatch(patch) };
}

/**
 * Apply a patch to `batch` (batch.mjs openBatch): refused for a missing batch, and `remote`/`hybrid` for a batch whose
 * `execution` file does not record `provider: true`. @returns the stored override.
 */
export function applySetExecution(batch, patch) {
  if (!batch.exists()) throw new Error(`no batch ${batch.id}`);
  const p = validateExecutionPatch(patch);
  if ((p.mode === "remote" || p.mode === "hybrid") && batch.readExecution()?.provider !== true) {
    throw new Error(`batch ${batch.id} has no remote provider; placement ${p.mode} needs one: start a new batch with forge.yaml execution`);
  }
  return batch.setExecution(p);
}

/** Text for a stored override: `max_remote 2, placement hybrid`. */
export function formatOverride(o) {
  const s = sanitizeOverride(o) ?? {};
  return [s.maxRemote !== undefined ? `max_remote ${s.maxRemote}` : null, s.mode ? `placement ${s.mode}` : null].filter(Boolean).join(", ") || "no change";
}

/**
 * Hybrid validation weight (#4256) that is computed only when first needed: `initial` (already computed) or `compute()`
 * started on the first `get()`; until it resolves (or when it fails) a light weight is used.
 */
export function lazyWeight({ initial = null, compute = null } = {}) {
  let w = initial, started = initial !== null;
  return {
    get: () => {
      if (!started && typeof compute === "function") {
        started = true;
        Promise.resolve().then(compute).then((r) => { w = r ?? LIGHT_WEIGHT; }, () => { w = LIGHT_WEIGHT; });
      }
      return w ?? LIGHT_WEIGHT;
    },
  };
}

/**
 * Put live `max`, `fallbackLocal` and `place` getters on `base` (the `remote` object orchestrate gets; never spread it
 * afterwards, a spread freezes the getters). `place(exec, n)` places one lane under the effective exec (execution.mjs
 * `placeLane` with the remote or hybrid facts); mode `local` places every new lane on the host. `onChange(exec)` is
 * called once each time the effective `{mode, maxRemote}` differs from the last one seen (the pinned one first).
 */
export function liveRemote(base, { exec, readOverride = () => null, place, onChange = null }) {
  const keyOf = (e) => `${e.mode}|${e.maxRemote}`;
  let last = keyOf(effectiveExecution(exec, null));
  const current = () => {
    let o = null;
    try { o = readOverride() ?? null; } catch { o = null; }
    const e = effectiveExecution(exec, o);
    const k = keyOf(e);
    if (k !== last) { last = k; try { onChange?.(e); } catch { /* advisory */ } }
    return e;
  };
  return Object.defineProperties(base, {
    max: { get: () => current().maxRemote, enumerable: true, configurable: true },
    fallbackLocal: { get: () => { const e = current(); return e.mode === "hybrid" && Number.isInteger(e.maxRemote) && e.maxRemote >= 1; }, enumerable: true, configurable: true },
    place: {
      value: (n) => {
        const e = current();
        if (e.mode === "local") return { where: "local", reason: "live placement: local" };
        return place(e, n);
      },
      enumerable: true, configurable: true, writable: true,
    },
  });
}
