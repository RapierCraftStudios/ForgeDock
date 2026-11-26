// Seam for the gap audit of an active pipeline/env/pool failure (#6078 fills this in). Until then a no-op: null means "no gap finding".
/** @param {object} bundle the evidence bundle of lane-audit.mjs  @param {object} [classified] the signature match, when any */
export async function auditGap(bundle, classified = null) { // eslint-disable-line no-unused-vars
  return null;
}
