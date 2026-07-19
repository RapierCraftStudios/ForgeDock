/**
 * Context-pack schema — versioned JSON shape + validator for the
 * deterministic context-pack builder (milestone #18, forge#2680).
 *
 * A "context pack" is the structured, size-capped bundle of prior-run
 * evidence (FORGE annotation excerpts, related-issue summaries, code-path
 * hints, ...) that a future mining/assembly pipeline (forge#2701 miner,
 * forge#2702 assembler) hands to a phase instead of re-discovering the same
 * context by prose search every run. This module defines the contract those
 * sub-issues build against — nothing here consumes or produces packs itself.
 *
 * Design constraints (forge#2700 acceptance criteria):
 *   - `schema_version` is present on every pack so a consumer can mechanically
 *     reject a pack built against an incompatible future schema and fall back
 *     to the current prose-mining path (fail-open — see forge#2680).
 *   - `validateContextPack(pack)` never throws on malformed input; it returns
 *     a structured `{valid, errors, truncated}` result, mirroring the
 *     non-throwing contract `validate()` in validate.js already establishes
 *     for FORGE annotations (see validate.js:26-29 for the one exception —
 *     a TypeError guard for a completely wrong argument type).
 *   - Size-cap constants live here, not in the miner/assembler, so both
 *     sub-issues import one shared definition instead of hardcoding limits
 *     that can drift apart.
 *   - A pack that deliberately dropped content in-band because it hit a size
 *     cap sets `truncated: true` and is VALID, distinct from a malformed pack.
 *   - No inline FORGE marker literals: this module declares no marker/phase
 *     name strings. If a future revision needs to reference one (e.g. to tag
 *     which pipeline phase a slice was mined for), it MUST import from
 *     `./types.js` or `./phases.js` — never re-declare the literal, per the
 *     precedent established in forge#2378/forge#1669.
 *
 * @license MIT
 */

/** Current schema version. Bump on any incompatible shape change; consumers
 * compare a pack's `schema_version` against this constant and MUST reject
 * (fail open to prose mining) on mismatch rather than guess compatibility. */
export const SCHEMA_VERSION = 1;

/** Per-phase pack slice names a context pack may carry. Kept here (not
 * re-derived from PHASE_IDS in phases.js) because a context-pack slice is a
 * narrower, purpose-built concept than a full pipeline phase id — not every
 * PHASE_IDS entry produces a mined slice, and this list is expected to grow
 * independently of the phase table. */
export const PACK_SLICE_NAMES = ['investigate', 'build', 'review'];

/** Maximum total serialized size (bytes, UTF-8) of a single context pack.
 * Shared by the miner (#2701, decides what to keep) and the assembler
 * (#2702, decides how to lay it out) so neither hardcodes its own limit. */
export const MAX_PACK_BYTES = 32 * 1024;

/** Maximum serialized size (bytes, UTF-8) of a single per-phase slice within
 * a pack. Enforced independently of MAX_PACK_BYTES so one oversized slice
 * cannot silently starve the other slices of their share of the pack. */
export const MAX_SLICE_BYTES = 12 * 1024;

/** Maximum number of entries a pack's `slices` array may declare. Enforced as
 * a cheap, O(1) upfront bound — checked before the per-slice validation loop
 * and before the whole-pack `JSON.stringify` size check below — so a pack
 * crafted with many individually size-valid slices cannot force the cost of
 * full iteration plus full serialization before being rejected. Set well
 * above the 3 currently-defined PACK_SLICE_NAMES to avoid constraining any
 * near-term legitimate use. */
export const MAX_SLICES = 64;

/** Field name a pack sets to `true` when the miner/assembler dropped content
 * in-band to stay under a size cap. Distinguishes an intentionally-shortened
 * pack (still valid) from a malformed one. Exported as a named constant
 * (rather than a bare string literal reused across this file and consumers)
 * so a future rename is a single-point change. */
export const TRUNCATED_FIELD = 'truncated';

/**
 * @typedef {Object} ContextPackSlice
 * @property {string} phase - one of PACK_SLICE_NAMES
 * @property {string} content - mined/assembled text for this phase slice
 * @property {boolean} [truncated] - true if this slice's content was cut to
 *   stay under MAX_SLICE_BYTES
 */

/**
 * @typedef {Object} ContextPack
 * @property {number} schema_version - must equal SCHEMA_VERSION for a consumer
 *   to trust the shape below; a mismatch means "fail open to prose mining",
 *   not "attempt to interpret anyway"
 * @property {number} issue - issue number the pack was built for
 * @property {ContextPackSlice[]} slices - per-phase mined/assembled content,
 *   each slice's `phase` drawn from PACK_SLICE_NAMES
 * @property {boolean} [truncated] - true if the pack as a whole (not just an
 *   individual slice) dropped content to stay under MAX_PACK_BYTES
 */

/**
 * Validate a context pack against the current schema.
 *
 * Never throws for malformed pack content — every shape/type problem is
 * reported as a structured error string. The only thrown error is a
 * TypeError for a completely wrong argument type (not an object at all),
 * mirroring validate.js's own top-level guard.
 *
 * @param {ContextPack} pack
 * @returns {{valid: boolean, errors: string[], truncated: boolean}}
 */
export function validateContextPack(pack) {
  if (pack === null || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new TypeError('validateContextPack() expects a ContextPack object');
  }

  const errors = [];

  // schema_version: presence, type, and exact-match against SCHEMA_VERSION.
  // A version mismatch is reported with a message distinct from "missing" so
  // a consumer can tell "this pack is stale/future" apart from "this pack is
  // broken" — the former is expected to happen as the schema evolves.
  if (!('schema_version' in pack)) {
    errors.push('Missing required field "schema_version"');
  } else if (typeof pack.schema_version !== 'number') {
    errors.push(`Field "schema_version" must be a number, got ${typeof pack.schema_version}`);
  } else if (pack.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `Unsupported schema_version ${pack.schema_version} — this validator supports ${SCHEMA_VERSION}. Consumer should fail open to prose mining rather than interpret this pack.`,
    );
  }

  // issue: presence + type only (no further constraint — any positive
  // integer is a valid GitHub issue number, and this module has no reason to
  // reach across to GitHub to confirm the issue exists).
  if (!('issue' in pack)) {
    errors.push('Missing required field "issue"');
  } else if (typeof pack.issue !== 'number') {
    errors.push(`Field "issue" must be a number, got ${typeof pack.issue}`);
  }

  // slices: presence, array-ness, and per-slice shape.
  if (!('slices' in pack)) {
    errors.push('Missing required field "slices"');
  } else if (!Array.isArray(pack.slices)) {
    errors.push(`Field "slices" must be an array, got ${typeof pack.slices}`);
  } else if (pack.slices.length > MAX_SLICES) {
    // Cheap O(1) rejection on slice count, before any per-slice iteration or
    // the whole-pack JSON.stringify below — see MAX_SLICES doc comment.
    errors.push(
      `Field "slices" has ${pack.slices.length} entries, exceeding MAX_SLICES (${MAX_SLICES})`,
    );
  } else {
    pack.slices.forEach((slice, i) => {
      if (slice === null || typeof slice !== 'object' || Array.isArray(slice)) {
        errors.push(`slices[${i}] must be an object, got ${Array.isArray(slice) ? 'array' : typeof slice}`);
        return;
      }
      if (!('phase' in slice)) {
        errors.push(`slices[${i}] is missing required field "phase"`);
      } else if (typeof slice.phase !== 'string') {
        errors.push(`slices[${i}].phase must be a string, got ${typeof slice.phase}`);
      } else if (!PACK_SLICE_NAMES.includes(slice.phase)) {
        errors.push(
          `slices[${i}].phase "${slice.phase}" is not a recognized slice name — must be one of: ${PACK_SLICE_NAMES.join(', ')}`,
        );
      }
      if (!('content' in slice)) {
        errors.push(`slices[${i}] is missing required field "content"`);
      } else if (typeof slice.content !== 'string') {
        errors.push(`slices[${i}].content must be a string, got ${typeof slice.content}`);
      } else {
        const sliceBytes = Buffer.byteLength(slice.content, 'utf8');
        if (sliceBytes > MAX_SLICE_BYTES && slice[TRUNCATED_FIELD] !== true) {
          errors.push(
            `slices[${i}].content is ${sliceBytes} bytes, exceeding MAX_SLICE_BYTES (${MAX_SLICE_BYTES}) without slices[${i}].${TRUNCATED_FIELD} set to true`,
          );
        }
      }
      if (TRUNCATED_FIELD in slice && typeof slice[TRUNCATED_FIELD] !== 'boolean') {
        errors.push(`slices[${i}].${TRUNCATED_FIELD} must be a boolean, got ${typeof slice[TRUNCATED_FIELD]}`);
      }
    });
  }

  // Pack-level truncation flag: optional, but if present must be boolean.
  const packTruncated = pack[TRUNCATED_FIELD] === true;
  if (TRUNCATED_FIELD in pack && typeof pack[TRUNCATED_FIELD] !== 'boolean') {
    errors.push(`Field "${TRUNCATED_FIELD}" must be a boolean, got ${typeof pack[TRUNCATED_FIELD]}`);
  }

  // Whole-pack size cap: only enforced when the pack is otherwise well-formed
  // enough to serialize (avoids a confusing secondary error cascading from an
  // already-reported shape problem). An oversized pack is only an error when
  // it is NOT marked truncated — a pack that truncated to stay under the cap
  // and still measures over MAX_PACK_BYTES is a genuine bug in the producer,
  // so that combination still errors.
  if (errors.length === 0) {
    let packBytes;
    try {
      packBytes = Buffer.byteLength(JSON.stringify(pack), 'utf8');
    } catch {
      packBytes = null;
    }
    if (packBytes !== null && packBytes > MAX_PACK_BYTES && !packTruncated) {
      errors.push(
        `Pack is ${packBytes} bytes, exceeding MAX_PACK_BYTES (${MAX_PACK_BYTES}) without "${TRUNCATED_FIELD}" set to true`,
      );
    }
  }

  return { valid: errors.length === 0, errors, truncated: packTruncated };
}
