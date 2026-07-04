# Cinematic Onboarding TUI — Design

**Date:** 2026-07-03
**Status:** Approved (design); pending implementation plan
**Supersedes/extends:** `2026-06-09-intelligent-onboarding-design.md` (Pillars A & B were built as modules but never wired into the CLI; this design closes that seam and defines the visual/experiential layer on top)

## Problem

The onboarding audit (2026-07-03) found two classes of failure:

1. **The intelligent onboarding is dead code.** `init-detect.mjs` (confidence-scored detection), `annotatedReviewScreen` (tui.mjs:835-1170), `init-enrich-api.mjs` (BYO-key AI enrichment), `registry.mjs`, and `bin/hooks/session-start.mjs` all exist with tests — and none are reachable. `forgedock.mjs`'s `init()` uses its own inline template; `install()` never registers the SessionStart hook; `enable`/`disable`/`status` don't exist.
2. **The funnel lies.** README advertises `npx forgedock demo` (dead — `Unknown command`), `integrate` (dead), and a CLAUDE.md injection that never happens. `getting-started.md` sends users to `/forgedock-init`, which hard-errors without a forge.yaml. `CONFIG.md` documents `--manual`/`--verbose` flags that parse nowhere. `plugin.json` says 1.0.1 while `package.json` says 1.0.8.

Beyond correctness, the shipped experience is plain warnings-and-homework. The goal is an install that feels revolutionary.

## Decisions (locked with user)

| Decision | Choice |
| --- | --- |
| TUI stack | Zero-dependency, hand-rolled — extend existing `tui.mjs`, no frameworks |
| Scope | Full onboarding arc: preflight → install → detect → review → celebrate, plus SessionStart hook wiring and `enable`/`disable`/`status`. `forgedock demo` is **out of scope** (own milestone) |
| Motion | Full cinematic, **always** — no first-run-only fast path; every command plays its full choreography. Automatic degradation (non-TTY/CI/`NO_COLOR`) and explicit escape hatches (`--fast`, `FORGE_NO_MOTION=1`). Note: an already-configured bare invocation shows the status screen (per approved storyboard) — that screen has its own full choreography; it doesn't replay the install acts |
| Visual identity | **Molten Forge**: fire-orange → amber gradients, "forging" language |
| Logo treatment | **Chrome & Ember**: block-art F mark keeps the official metallic chrome/champagne gradient; ember lives in the wordmark and UI. Hero mark on install; compact 4-row lockup on all other commands |
| Flow shape | **One continuous journey**: bare `npx forgedock` plays the whole arc; `install`/`init` are aliases that jump into the relevant acts |
| Architecture | **Cinema layer + journey orchestrator** (new `bin/cinema.mjs` + `bin/journey.mjs`; `forgedock.mjs` becomes a thin router) |

## The Experience — five acts, one keypress

The only interaction in the happy path is a single Enter at Act IV. Total added latency from theater: motion overlays real work wherever work exists; pure-theater beats (shimmer, quench flash) total ≈1.2s.

### Act I — Ignition (~2.5s)

Chrome block-art mark materializes with a one-pass heat-shimmer sweep (~800ms); ember gradient wordmark `F O R G E D O C K` + version; rule line "lighting the forge". Preflight rows appear one-by-one, each live (`○` → braille spinner → `✔`):

- Node ≥18 (version shown)
- git present + repo detected
- Claude Code (`~/.claude` exists)
- GitHub CLI installed + authenticated (account shown)

A failed check renders an ember-bordered **fix card** with the exact copy-paste remedy (e.g. `winget install GitHub.cli`, `gh auth login`) and the journey **continues** with whatever still works. Preflight failures are advisory, not fatal — missing `gh` degrades detection confidence, it does not stop the forge.

### Act II — Forging (real work)

- Progress bar with molten leading edge (`█▓▒░`) and per-command name ticker while symlinking the 24 commands into `~/.claude/commands` (existing logic, restyled).
- **Seam-closing (new):** merge a SessionStart hook entry into `~/.claude/settings.json` (idempotent read-modify-write; preserves existing hooks; removed on `uninstall`; malformed JSON → skip with fix card, never clobber). Write the registry entry marking the directory forge-managed.
- Settle lines: `✔ 24 slash commands linked`, `✔ SessionStart hook registered`, `✔ directory forge-managed`.

### Act III — Reading your repository

Each detection field resolves as a live row: value + confidence badge + source, e.g.
`✔ owner/repo  RapierCraftStudios/ForgeDock  [high] git remote`.
Driven by the existing `detectConfig()` (init-detect.mjs). Fields: owner/repo, default branch, staging branch, project name, description, worktree base, project board (via `gh` when available). If `ANTHROPIC_API_KEY` is set, `init-enrich-api.mjs` fills review/verification sections (`✦ enriching with AI…`); if not, one quiet skip line. Spinners here cover *actual* latency (git/gh/API calls) — nothing is artificially slowed.

### Act IV — The Review (the single interaction)

The existing `annotatedReviewScreen` (tui.mjs), wired in at last and restyled to ember: numbered field table with `[high]/[med]/[low]` badges, confidence legend, low-confidence warning. `Press Enter to forge, or a number to edit a field`. Low-confidence fields are written with `# TODO(forgedock:<field>)` comments instead of blocking. Existing forge.yaml → overwrite banner + backup to `forge.yaml.bak` before write (existing behavior preserved).

### Act V — Forged (celebration)

Compact mark flashes white-hot once (quench, ~400ms), then settles:

- `Forged.` + **real elapsed time** (`install → config in 34s`) — proof, not hype
- Receipt lines: forge.yaml written (with TODO count), commands + hook active
- Boxed "what's next" card: `1. open claude in this repo` / `2. run /work-on next`
- Footer: docs link + star nudge

Next Claude Code session, the now-installed SessionStart hook greets the user with the command table — the experience continues past the terminal.

### Re-runs and aliases

- Bare `npx forgedock` in an already-configured repo → short status screen (compact lockup, current config summary, hook state) + offer to review config. Not the full movie.
- `npx forgedock install` → Acts I–II (+ III–V only if unconfigured, matching today's auto-init).
- `npx forgedock init` → Acts III–V.
- `enable` / `disable` / `status` → registry operations, compact lockup, instant.
- `update` / `uninstall` → existing logic, compact restyle; `uninstall` also removes the hook entry and registry entries.

## Architecture

### `bin/cinema.mjs` (new — animation engine)

Kept separate from tui.mjs (already 1,171 lines). Exports:

- Truecolor per-cell gradient rendering with 256-color fallback (`COLORTERM`/`TERM` detection); gradient text lines and gradient block art
- `renderMark(size)` — the chrome F mark, hero (8-row) and compact (4-row); block-art geometry approved v1 from mockups, may be pixel-tuned during implementation
- `shimmer(lines, opts)` — one-pass highlight sweep
- `reveal(rows, opts)` — staged live rows (`○` → spinner → `✔`/`✖`/fix card)
- `progressBar` molten variant with ticker
- `motionEnabled()` — the single motion gate: TTY ∧ ¬`NO_COLOR` ∧ ¬`FORGE_NO_MOTION` ∧ ¬`--fast` ∧ ¬CI

**No alternate screen buffer.** Animations redraw in place (cursor-up) only while active, then settle to static lines — scrollback keeps a complete plain receipt of the run.

### `bin/journey.mjs` (new — choreographer)

Five act functions — `preflight()`, `forge()`, `read()`, `review()`, `celebrate()` — over a shared context object; each act independently callable (for aliases) and unit-testable. Orchestrates the existing modules: `init-detect.mjs`, `init-enrich-api.mjs`, `annotatedReviewScreen`, `registry.mjs`. The forge.yaml writer moves here, driven from the detection `ConfigDraft` (single source of truth; deletes the duplicate inline template in forgedock.mjs) and emits `# TODO(forgedock:<field>)` for low-confidence values.

### `bin/forgedock.mjs` (shrinks to router)

Command dispatch → journey acts as above. Fixes: `HOME` check gains `USERPROFILE`/`os.homedir()` fallback (currently hard-fails on bare Windows shells); flag parsing added (`--fast`, `--manual`, `--verbose`). `--manual` = plain-prompt path (no detection auto-accept), making CONFIG.md's documented flags real.

### Hook wiring (the seam)

`forge()` merges into `~/.claude/settings.json`:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
  "command": "node \"$FORGE_HOME/bin/hooks/session-start.mjs\"" } ] } ] } }
```

The command path is resolved to the absolute installed package location at install time (the same resolution `install()` already performs for symlink sources) — written as an absolute path, not a literal env reference, so the hook works regardless of shell profile.

Idempotent (detects its own entry, never duplicates), preserves unrelated hooks, guards malformed JSON (skip + fix card, never overwrite), and is removed by `uninstall`. This makes the existing `session-start.mjs` (managed-active greeting / missing-config nudge / one-time unmanaged nudge) actually fire.

## Degradation ladder

1. Full cinematic — interactive TTY, truecolor
2. 256-color — same choreography, quantized gradients
3. `NO_COLOR` — monochrome, motion intact
4. `--fast` / `FORGE_NO_MOTION=1` — instant renders, no animation frames
5. Non-TTY/CI — deterministic plain sequential log, same information, zero ANSI animation; review screen auto-accepts nothing — in non-TTY, detection results are written with TODO flags and the run says so (preserves current "never block CI" behavior while still protecting existing configs via the existing non-interactive abort on overwrite)
6. Narrow terminals (<60 cols) — compact lockup replaces hero mark; tables wrap to stacked rows

## Error handling

- **Never a dead stop, never a lie.** Preflight fix cards + continue; degraded steps stated inline at the moment they happen and echoed in the Act V receipt (e.g. `2 fields flagged # TODO`). No silently skipped sections.
- **Ctrl-C per act:** restore cursor/style, print partial-state summary (`commands installed, config not written — run npx forgedock init to finish`), exit cleanly. No half-drawn screens, no orphaned temp files.
- **Filesystem safety unchanged or better:** forge.yaml backup before overwrite; settings.json read-modify-write with parse guard; registry writes stay atomic (existing).

## Testing

Extends the existing `node --test` suite in `bin/tests/`:

- **Acts:** unit tests with injected exec/IO stubs — preflight verdict matrix, hook-merge idempotency (twice → one entry), unrelated-hook preservation, TODO-flag emission, ConfigDraft→YAML writer output.
- **Degradation:** snapshot tests of the non-TTY plain log (`FORGE_NO_MOTION=1`, piped stdout) — deterministic byte-for-byte.
- **Cinema:** frame-function tests (gradient math, color-mode fallback selection), not timing tests — motion verified by eye; everything beneath it deterministic.
- **Windows first-class:** path handling, `USERPROFILE` fallback, symlink-vs-copy behavior — primary dev platform is Windows.

## Docs truth-pass (ships in this milestone)

- **README:** remove `demo` (deferred) and `integrate`; replace CLAUDE.md-injection claim with the (now true) hook story; collapse the two-step install to one `npx forgedock`; requirements list gains Node ≥18.
- **getting-started.md:** fix the `/forgedock-init`-without-forge.yaml dead end; document the journey.
- **CONFIG.md:** `--manual`/`--verbose` now real; describe actual flags only.
- **Versioning:** reconcile `plugin.json` (1.0.1) with `package.json` (1.0.8); ship as **1.1.0**.
- **demo.tape:** re-record after implementation so the README gif shows the real flow.

## Out of scope

- `npx forgedock demo` (sandbox pipeline showcase) — its own future milestone
- Self-healing `validate` (spec 2026-06-09 Pillar C, AI-fix loop) — future
- Skill-backend enrichment inside Claude Code — future; API backend + deterministic baseline only for now

## Success criteria

- Fresh `npx forgedock` on a clean machine: zero commands to remember, one Enter, ends with a valid forge.yaml, installed commands, live SessionStart hook, and next-step card — in under ~60s on a normal repo.
- Re-run is a status screen, not a movie sit-through beyond its own short choreography.
- CI/non-TTY runs produce a stable plain log and never hang on a prompt.
- No user-facing doc advertises a command or behavior that doesn't exist.
