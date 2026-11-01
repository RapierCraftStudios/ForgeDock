// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Opt-in nightly `selftest --live` (#4894), run from schedd's due callback on the host (never GitHub Actions). Off unless
// forge.yaml `selftest.nightly_interval_hours` is a positive number. A failing run files ONE issue naming the failed step;
// the next failure edits that issue (same dedupe as the prod-watch storm summary) instead of filing another.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schedDir } from "./sched.mjs";

export const NIGHTLY_MARKER = "<!-- FORGE:SELFTEST_NIGHTLY -->";
const STATE_FILE = "selftest-nightly.json";
const neutralize = (s) => String(s ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");

/** Interval in hours from the forge.yaml text, or null when the key is unset, zero or not a number (= nothing scheduled). */
export function nightlyConfig(raw) {
  const sec = String(raw ?? "").split(/^selftest:/m)[1]?.split(/^\S/m)[0] ?? "";
  const h = Number(/^\s+nightly_interval_hours:\s*["']?([\d.]+)/m.exec(sec)?.[1]);
  return h > 0 ? h : null;
}

function readLast(dir) {
  try { return Number(JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")).lastRun) || 0; } catch { return 0; }
}
function writeLast(dir, ts) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), JSON.stringify({ lastRun: ts }));
}

/**
 * One schedd pass. `runLive()` resolves {ok, step, message}. Never throws.
 * @returns {Promise<{ran:boolean, ok?:boolean, issue?:?number, action?:"create"|"edit"}>}
 */
export async function nightlyDue({ repo, cwd = process.cwd(), io, now = () => Date.now(), runLive, stateDir = schedDir() } = {}) {
  try {
    const file = join(cwd, "forge.yaml");
    const hours = nightlyConfig(existsSync(file) ? readFileSync(file, "utf8") : "");
    if (!hours || !repo) return { ran: false };
    if (now() - readLast(stateDir) < hours * 3600_000) return { ran: false };
    writeLast(stateDir, now()); // before the run: a crashing harness must not re-run every 15 min
    const r = await runLive();
    if (r.ok) return { ran: true, ok: true };
    const step = r.step ?? "unknown";
    const title = `selftest --live failed at step ${step} (nightly)`;
    const body = `The nightly \`forgedock selftest --live\` failed at step **${neutralize(step)}**.\n\n${neutralize(String(r.message ?? "").slice(0, 2000))}\n\nLast failure: ${new Date(now()).toISOString()}\n\n${NIGHTLY_MARKER}\n`;
    const open = JSON.parse(String(await io.gh(["issue", "list", "-R", repo, "--state", "open", "--search", `"FORGE:SELFTEST_NIGHTLY" in:body`, "--limit", "30", "--json", "number,body"])))
      .find((i) => String(i.body ?? "").includes(NIGHTLY_MARKER));
    if (open) {
      await io.gh(["issue", "edit", String(open.number), "-R", repo, "--title", title, "--body", body]);
      return { ran: true, ok: false, issue: open.number, action: "edit" };
    }
    const out = await io.gh(["issue", "create", "-R", repo, "--title", title, "--body", body]);
    return { ran: true, ok: false, issue: Number(/(\d+)\s*$/.exec(String(out).trim())?.[1]) || null, action: "create" };
  } catch { return { ran: false }; }
}
