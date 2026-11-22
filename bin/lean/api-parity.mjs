// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5821: replay one stored reviewer prompt through the CLI and the Messages API runner and compare the blocking findings.
 * Usage: node bin/lean/api-parity.mjs <prompt-file>   (needs ANTHROPIC_API_KEY and the claude CLI; run by an operator, not CI)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REVIEWER_SYSTEM, splitCacheablePrefix } from "./prompts.mjs";
import { runApiCall, apiKeyPresent } from "./api-runner.mjs";

/** Failing criteria ids from a reviewer reply: JSON rows `{id|criterion, status|pass}`; a row is blocking when it did not pass. */
export function blockingFindings(text) {
  const s = String(text ?? "");
  const j = (() => { for (const c of [/```(?:json)?\s*([\s\S]*?)```/.exec(s)?.[1], s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)]) { try { if (c) return JSON.parse(c); } catch { /* next */ } } return null; })();
  const rows = Array.isArray(j) ? j : Array.isArray(j?.rows) ? j.rows : Array.isArray(j?.criteria) ? j.criteria : [];
  return rows.filter((r) => r && (r.pass === false || /^(fail|failed|reject|rejected)$/i.test(String(r.status ?? r.verdict ?? "")))).map((r) => String(r.id ?? r.criterion ?? r.requirement ?? "?")).sort();
}

/** {match, onlyCli, onlyApi} for two reviewer replies. */
export function compareFindings(cliText, apiText) {
  const a = blockingFindings(cliText), b = blockingFindings(apiText);
  const onlyCli = a.filter((x) => !b.includes(x)), onlyApi = b.filter((x) => !a.includes(x));
  return { match: !onlyCli.length && !onlyApi.length, onlyCli, onlyApi };
}

/** Run both paths for `prompt`; `runCli` is the existing runner (role reviewer) and `runApi` defaults to the API runner. */
export async function replay({ prompt, runCli, runApi = (p) => runApiCall({ system: REVIEWER_SYSTEM, ...splitCacheablePrefix(p) }) }) {
  const [cli, api] = [await runCli(prompt), await runApi(prompt)];
  return { ...compareFindings(cli?.text, api?.text), cliCost: cli?.costUsd ?? null, apiCost: api?.costUsd ?? null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) { console.error("usage: api-parity.mjs <prompt-file>"); process.exit(2); }
  if (!apiKeyPresent()) { console.error("api-parity: ANTHROPIC_API_KEY is not set; the live parity run needs an API key"); process.exit(2); }
  const { makeLeanRunner } = await import("./effects.mjs");
  const runner = makeLeanRunner();
  const out = await replay({ prompt: readFileSync(file, "utf8"), runCli: (prompt) => runner({ role: "reviewer", issue: 0, cwd: process.cwd(), model: null, resume: null, system: REVIEWER_SYSTEM, readOnly: true, prompt }) });
  console.log(JSON.stringify(out));
  process.exit(out.match ? 0 : 1);
}
