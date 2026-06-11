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
 * Backends may emit human-readable prose before and/or after the JSON blob.
 * This function finds the outermost JSON object in the output using a
 * string-aware balanced-brace scanner: it tracks brace depth while skipping
 * over string literal contents (including backslash-escaped characters), so
 * braces inside JSON string values do not affect depth tracking and trailing
 * prose with braces does not extend the match past the correct closing '}'.
 * Falls back to the original draft if extraction or parsing fails.
 *
 * @param {string} output  - Raw text from the API response content block
 * @param {object} draft   - Original ConfigDraft (returned on failure)
 * @returns {object} Enriched ConfigDraft, or original draft on failure
 */
export function parseEnrichedDraft(output, draft) {
  if (!output || typeof output !== "string") return draft;

  // Find the first '{' then walk forward tracking brace depth, skipping over
  // string literal contents (with backslash-escape handling) so that:
  //   - Braces inside JSON string values (e.g. Go template syntax in
  //     project.description, Windows paths) do not affect depth.
  //   - Trailing prose containing '{' or '}' after the JSON blob does not
  //     extend the extraction past the correct top-level closing '}'.
  const start = output.indexOf("{");
  if (start === -1) return draft;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < output.length; i++) {
    const ch = output[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Found the closing brace of the top-level object — parse the candidate.
        try {
          const enriched = JSON.parse(output.slice(start, i + 1));
          // Basic sanity check: must have the required top-level sections.
          if (!enriched.project || !enriched.paths || !enriched.branches) {
            return draft;
          }
          return enriched;
        } catch {
          return draft;
        }
      }
    }
  }

  // No complete top-level JSON object found.
  return draft;
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
    if (data?.stop_reason === "max_tokens" && process.env.FORGEDOCK_DEBUG) {
      console.error(
        `  ${dim("[debug]")} api enrichment: response truncated by max_tokens — JSON parse may fail, falling back to baseline draft.`,
      );
    }
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
