/**
 * init-enrich-api.mjs — Anthropic API enrichment backend for ForgeDock init.
 *
 * Implements the same enrich(ConfigDraft) contract as the skill backend so the
 * selection ladder in forgedock.mjs can treat both backends interchangeably.
 *
 * Uses Node.js built-in fetch (Node 18+) — no SDK dependency required.
 * Reads ANTHROPIC_API_KEY from the environment; cleanly skips enrichment with
 * a helpful message when the key is absent, returning the original draft.
 */

import { dim, yellow, RESET } from "./tui.mjs";

/** Anthropic API endpoint for Messages. */
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Model used for config enrichment — cost-effective, fast, fits the task. */
const ENRICH_MODEL = "claude-haiku-4-5";

/** System prompt defining the enrich(ConfigDraft) contract. */
const SYSTEM_PROMPT =
  "You are the init-enrich backend for ForgeDock. Consume the ConfigDraft JSON, " +
  "enrich the hard sections (project_board, repos.satellites, review, verification) " +
  "by scanning the codebase identified in paths.root.value and querying GitHub via gh CLI, " +
  "then return ONLY the enriched ConfigDraft as a valid JSON object. " +
  "Every leaf must have shape { value, confidence, source, why }. " +
  "Do not modify project, paths, branches, or meta sections. " +
  "Output the JSON object alone with no surrounding prose.";

/**
 * Extract and parse the enriched ConfigDraft JSON from a backend response string.
 *
 * Backends may emit human-readable prose before and after the JSON blob.
 * This function finds the outermost JSON object in the output and parses it.
 * Falls back to the original draft if extraction or parsing fails.
 *
 * @param {string} output  - Raw text from the API response content block
 * @param {object} draft   - Original ConfigDraft (returned on failure)
 * @returns {object} Enriched ConfigDraft, or original draft on failure
 */
export function parseEnrichedDraft(output, draft) {
  if (!output || typeof output !== "string") return draft;

  // Use a greedy regex to find the first '{' and the last '}' in the output.
  // A brace-depth counter would misfire when JSON string values contain '{' or '}'
  // (e.g. project.description mentioning Go templates, Windows paths with env-var
  // syntax, or tech-stack notes). The regex finds the outermost boundaries and
  // delegates structural validation to JSON.parse.
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return draft;

  try {
    const enriched = JSON.parse(jsonMatch[0]);
    // Basic sanity check: must have the required top-level sections from the original draft.
    if (!enriched.project || !enriched.paths || !enriched.branches) {
      return draft;
    }
    return enriched;
  } catch {
    return draft;
  }
}

/**
 * Enrich a ConfigDraft by calling the Anthropic Messages API directly.
 *
 * This is the api backend for the init-enrich interface. It implements the same
 * enrich(ConfigDraft) contract as the skill backend so the selection ladder can
 * treat both interchangeably.
 *
 * When ANTHROPIC_API_KEY is absent, logs a helpful message and returns the
 * original draft unchanged so the caller can fall through to the deterministic
 * baseline.
 *
 * @param {object} draft - ConfigDraft from detectConfig()
 * @returns {Promise<object>} Enriched ConfigDraft, or the original draft on failure
 */
export async function enrich(draft) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.log(
      `  ${yellow("[!]")} No ANTHROPIC_API_KEY set — skipping API enrichment.` +
        ` ${dim("Set ANTHROPIC_API_KEY to enable BYO-key enrichment.")}${RESET}`,
    );
    return draft;
  }

  try {
    const draftJson = JSON.stringify(draft, null, 2);

    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ENRICH_MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: draftJson,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API returned ${response.status}`);
    }

    const data = await response.json();
    const text =
      data?.content?.[0]?.type === "text" ? data.content[0].text : "";
    return parseEnrichedDraft(text, draft);
  } catch (err) {
    if (process.env.FORGEDOCK_DEBUG) {
      console.error(
        `  ${dim("[debug]")} api enrichment failed: ${err.message}`,
      );
    }
    return draft;
  }
}
