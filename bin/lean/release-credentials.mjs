// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Credential split (#5561, epic #5549, invariants I1/I12): identity is not capability. Three roles: `driver` (the release
 * host: ledger, merge, release-branch pushes), `lane` (builder/fix/reviewer sandboxes: none of those) and `gate` (the gate
 * workflow: posts the gate status). `laneEnv` strips the driver token from every sandbox environment; `roleRefusal` names the
 * role and action it refuses.
 */
export const ROLES = Object.freeze(["driver", "lane", "gate"]);

/** Env names that carry the driver credential (the lane gets its own token under another name; a deployment whose driver token is named differently lists it in the policy); the policy `credentials.lane_env_strip` list adds more. */
export const DRIVER_ENV = Object.freeze(["FORGE_DRIVER_TOKEN", "FORGEDOCK_DRIVER_TOKEN", "FORGE_RELEASE_DRIVER_TOKEN"]);

const ALLOWED = { "ledger-write": ["driver"], "gate-post": ["gate"], merge: ["driver"], push: ["driver"] };
const PROTECTED_BRANCH = /^(release|train)\//;

/** A copy of `env` without the driver token and the `extra` names: the only environment lane, fix and reviewer sandboxes get. */
export function laneEnv(env = process.env, extra = []) {
  const drop = new Set([...DRIVER_ENV, ...(Array.isArray(extra) ? extra : [])]);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)));
}

/**
 * @param {string} role one of ROLES
 * @param {"ledger-write"|"gate-post"|"merge"|"push"} action
 * @param {{branch?: string, fixPush?: boolean}} [opts] a `push` to release/* or train/* is refused unless it is the one allowed fix push (lane) or by the driver
 * @returns {string|null} the refusal naming role and action, null when allowed
 */
export function roleRefusal(role, action, opts = {}) {
  if (!ROLES.includes(role)) return `role ${JSON.stringify(role ?? null)} is unknown and may not ${action}`;
  if (action === "push" && !PROTECTED_BRANCH.test(String(opts.branch ?? ""))) return null;
  if (action === "push" && role === "lane" && opts.fixPush === true) return null;
  return ALLOWED[action]?.includes(role) ? null : `role ${role} may not ${action}${opts.branch ? ` on ${opts.branch}` : ""}`;
}

/** Throws `{refused}` when `ctx.credential` may not `action`. */
export function assertRole(ctx, action, opts) {
  const why = roleRefusal(ctx?.credential, action, opts);
  if (why) throw Object.assign(new Error(why), { refused: why });
}
