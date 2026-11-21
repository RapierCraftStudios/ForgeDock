---
status: fresh
anchor: bin/lean/winspawn.mjs
created: 2026-11-21
---

# ADR: lean lanes classify Windows paths and launch npm .cmd shims without a shell

## Context

On Windows every lean lane failed before any work (#5799). `lean.mjs` decided whether a git-returned path was absolute with `startsWith("/")`; git prints `C:/...`, so `info/exclude` was prefixed with the worktree and scratch setup hit ENOENT (`engine-error`). The same check let the branch writer lock (#5333) fail open. Once past that, `execFile` (`shell:false`) could not find tools installed as npm `.cmd` shims (`pnpm`, `npx`), so dependency install and validate ended `env.tool_missing` (`spawn pnpm ENOENT`) on hosts where the tool works in every shell.

## Decision

- `bin/lean/winspawn.mjs` `isAbsPath`: POSIX, drive (`C:/`, `C:\`) and UNC paths are absolute, on every platform (unit tests run on Linux). The four `startsWith("/")` sites in `lean.mjs` use it.
- `resolveSpawn(bin, args)`: on win32 only, a bare name is resolved via PATH x PATHEXT. `.exe`/`.com` run as found. An npm `.cmd` shim runs as its `%dp0%`-relative native `.exe`, or as `node <script>` (the `node.exe` beside the shim if present, else `process.execPath`). `effects.mjs` `pexec` goes through it.
- Not `shell: true`: argv would be parsed by cmd.exe (injection). An unrecognised batch script is never run; the bare name falls through and fails as before.

## Consequences

Windows hosts run lanes end to end without per-host PATH workarounds (a standalone `pnpm.exe`). Other spawn sites (`runWithInput`, `execCapped`) keep plain `execFile`; route them through `resolveSpawn` if a shimmed tool shows up there.
