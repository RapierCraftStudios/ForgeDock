// Seam for the LLM classification of evidence no signature matched (#6079 fills this in). Until then a no-op: null means "unclassified".
/** @param {object} bundle the evidence bundle of lane-audit.mjs */
export async function classifyWithLlm(bundle) { // eslint-disable-line no-unused-vars
  return null;
}
