// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #5799: Windows-safe path and spawn helpers for lean lanes.
 *
 * - `isAbsPath`: git on Windows prints `C:/...` (or `C:\...`, `\\server\...`), which a `startsWith("/")` check reads as
 *   relative, so the lane prefixed the worktree and wrote to `<wt>/C:/...` (ENOENT at scratch setup).
 * - `resolveSpawn`: `execFile`/`spawn` with `shell:false` cannot launch a bare `pnpm` on Windows when it is installed as
 *   an npm `.cmd` shim, so every validate/install ended `env.tool_missing` (spawn ENOENT). The shim is resolved to what it
 *   runs (a native `.exe`, or `node <script>`) and launched directly; cmd.exe never parses the argv.
 */
import * as nodeFs from "node:fs";
import { win32 } from "node:path";

/** True for a POSIX absolute path, a Windows drive path (`C:/`, `C:\`) or a UNC path. Platform-independent on purpose. */
export const isAbsPath = (p) => {
  const s = String(p ?? "");
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");
};

const NODE_SCRIPT_RE = /"%(?:~)?dp0%?[\\/]([^"\r\n%]+\.(?:c|m)?js)"\s+%\*/i;
const EXE_DIRECT_RE = /(?:^|\r?\n)\s*"%(?:~)?dp0%?[\\/]([^"\r\n%]+\.(?:exe|com))"\s+%\*\s*(?:\r?\n|$)/i;

/**
 * Resolve `bin` the way cmd.exe would (PATH x PATHEXT) and return a `{ bin, args }` pair `execFile` can run with
 * `shell:false`. Non-Windows, paths with a directory part, and unresolvable names are returned unchanged.
 */
export function resolveSpawn(bin, args = [], { platform = process.platform, env = process.env, fs = nodeFs, nodePath = process.execPath } = {}) {
  const same = { bin, args };
  if (platform !== "win32" || typeof bin !== "string" || !bin || /[\\/]/.test(bin)) return same;
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const hasExt = exts.includes(win32.extname(bin).toLowerCase());
  for (const dir of String(pathVar).split(";").filter(Boolean)) {
    for (const ext of hasExt ? [""] : exts) {
      const file = win32.join(dir, bin + ext);
      let ok = false;
      try { ok = fs.statSync(file).isFile(); } catch { ok = false; }
      if (!ok) continue;
      const e = win32.extname(file).toLowerCase();
      if (e === ".exe" || e === ".com") return { bin: file, args };
      if (e !== ".cmd" && e !== ".bat") continue; // .js/.vbs etc.: not launchable without a host; keep looking
      let shim = "";
      try { shim = String(fs.readFileSync(file, "utf8")); } catch { continue; }
      const exe = shim.match(EXE_DIRECT_RE);
      if (exe) {
        const target = win32.join(dir, ...exe[1].split(/[\\/]+/));
        if (fs.existsSync(target)) return { bin: target, args };
      }
      const js = shim.match(NODE_SCRIPT_RE);
      if (js) {
        const script = win32.join(dir, ...js[1].split(/[\\/]+/));
        if (!fs.existsSync(script)) continue;
        const localNode = win32.join(dir, "node.exe");
        return { bin: fs.existsSync(localNode) ? localNode : nodePath, args: [script, ...args] };
      }
      // An unknown batch script is never run through cmd.exe (argv injection); keep looking, then fall through.
    }
  }
  return same;
}
