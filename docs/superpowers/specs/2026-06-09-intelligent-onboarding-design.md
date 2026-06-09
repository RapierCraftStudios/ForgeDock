# Intelligent, Idiot-Proof Onboarding — Design Spec

**Date:** 2026-06-09
**Status:** Approved (design); pending implementation plan
**Scope:** One milestone, four phases

## Problem

Today's onboarding (`npx forgedock` TUI + `forgedock init` + the `forgedock-init`
skill) works but asks the first-time user ~12 questions across project / paths /
branches / optional sections, with little explanation of *why* each is asked or
*what* a good answer looks like. The deterministic auto-detect is decent, but the
genuinely hard sections (project board field mapping, satellites, review context,
verification endpoints) still fall back to manual prompts. There is no per-directory
control: ForgeDock commands install globally and there is no notion of "activate
here / stay silent there."

We want onboarding to be **intelligent** (AI fills the config), **idiot-proof**
(near-zero questions, everything explained), and **scoped** (a Claude Code hook
that activates ForgeDock only in directories the user has opted into).

## Vision

Open `claude` in any repo → a SessionStart hook resolves the directory's ForgeDock
state → if managed and active and unconfigured, an AI agent infers the **entire**
`forge.yaml` from the codebase + GitHub → the user reviews **one annotated screen**
and presses Enter. No wizard. Per-directory enable/disable means ForgeDock only
wakes up where wanted.

## Architecture — three pillars

### Pillar A — Autopilot config generation (the "intelligence")

Layered backends behind **one interface** so the experience degrades gracefully
(the chosen "hybrid" model):

- **`init-detect`** — deterministic, no AI. Refactors today's git / tech-stack /
  board detection into a pure module that returns a `ConfigDraft` plus a
  **confidence score per field** (`high` = verified from a concrete source,
  `medium` = inferred, `low` = guessed default).
- **`init-enrich`** — AI enrichment. Consumes a `ConfigDraft`, deeply infers the
  hard sections, and raises confidences. Two interchangeable backends sharing one
  contract:
  - **skill backend** — runs inside Claude Code; no API key; uses existing CC auth.
    *Primary path.*
  - **api backend** — the CLI calls the Anthropic API directly with a BYO
    `ANTHROPIC_API_KEY`. *Used when Claude Code is not present.*
- **`review-render`** — a single annotated review screen. Every field is shown with
  its **source**, **confidence**, and a plain-language "why this value." Enter to
  accept all; inline-edit to change any field. **Unknowable items get a sensible
  default plus an inline `# TODO(forgedock:<field>)` flag in the YAML — never a
  blocking prompt.**

**Backend selection logic:**
1. Always run `init-detect` to produce the baseline draft.
2. If running inside Claude Code → `init-enrich` via **skill** backend.
3. Else if `ANTHROPIC_API_KEY` present → `init-enrich` via **api** backend.
4. Else → skip enrichment; render the deterministic baseline (today's quality, but
   through the new annotated review screen).

### Pillar B — Claude Code hook + per-directory toggle

- **SessionStart hook**, installed into `~/.claude/settings.json` by
  `forgedock install`. On each CC session it resolves the cwd's state and acts:
  - **managed + active** → inject ForgeDock context (a `forge.yaml` summary +
    available commands); if config is missing or stale, offer a one-shot autopilot
    init.
  - **managed + opted-out** → completely silent (no output, no context injection).
  - **unmanaged** → an optional, one-time, suppressible "Enable ForgeDock here?"
    nudge.
- **State model** ("marker + global opt-out"):
  - A directory is **managed** iff it contains `forge.yaml` **or** a lightweight
    `.forgedock` marker (lets a project signal "ForgeDock-managed" before a full
    config exists).
  - A central `~/.claude/forgedock/registry.json` tracks explicit **per-directory
    opt-out** plus last-seen metadata. Opt-out wins over the marker.
- **New CLI commands:** `forgedock enable [dir]`, `forgedock disable [dir]`,
  `forgedock status [dir]`.
- **Known constraint (explicit, accepted):** Claude Code slash-commands install
  **globally**, so "disable per dir" means the **hook stays silent and injects
  nothing** in that directory — it does not physically remove or hide the global
  commands. This is the achievable and intended semantics.

### Pillar C — Idiot-proofing (cross-cutting)

- **Self-healing `validate`** — on a validation failure, the AI proposes (and, with
  confirmation, applies) the fix instead of only printing an error.
- **Actionable preflight** — failures (`gh` missing, not authed, Node too old) show
  copy-paste fix commands (partially exists today; standardize it).
- **Escape hatch** — `--manual` / `--verbose` runs the full guided wizard for power
  users who *want* every prompt.

## Components & interfaces (designed for isolation)

| Unit | Purpose | Depends on | Testable in isolation? |
|------|---------|-----------|------------------------|
| `init-detect` | Pure baseline `ConfigDraft` + per-field confidence | git, fs (read-only) | Yes — fixture repos → expected draft |
| `init-enrich` (skill) | AI enrichment inside CC | CC session, draft contract | Contract test + recorded fixture |
| `init-enrich` (api) | AI enrichment via Anthropic API | `ANTHROPIC_API_KEY`, draft contract | Contract test against same interface |
| `review-render` | Annotated review/accept/edit TUI | draft + confidence, tui.mjs | Yes — render snapshot from a draft |
| `registry` | Resolve dir state; read/write opt-out + markers | fs | Yes — state-resolution matrix |
| `session-hook` | Thin SessionStart script; emits context JSON | registry | Yes — simulated SessionStart payloads |

**`ConfigDraft` contract** (shared by detect → enrich → render): a structured
object mirroring `forge.yaml` sections, where each leaf is `{ value, confidence,
source, why }`. This is the single seam that lets the three enrichment backends and
the renderer stay decoupled.

## Data flow (autopilot happy path)

```
open `claude` in repo
  → SessionStart hook fires
  → registry resolves: managed (forge.yaml absent) + active
  → hook suggests autopilot init  (or user runs `forgedock init`)
  → init-detect            → baseline ConfigDraft + confidences
  → init-enrich (skill)    → enriched ConfigDraft
  → review-render          → annotated screen → Enter to accept
  → write forge.yaml (with any # TODO(forgedock:…) flags)
  → validate (self-healing on failure)
```

## Error handling

- **No git remote / detached repo:** `init-detect` lowers confidence, leaves fields
  as `low`-confidence defaults with TODO flags; never crashes.
- **`gh` unauthenticated:** GitHub-derived sections (board, satellites) are skipped
  with a flagged TODO and a copy-paste `gh auth login` hint.
- **Enrichment backend unavailable / API error:** fall through the backend-selection
  ladder; worst case is the deterministic baseline through the review screen.
- **`forge.yaml` already exists:** existing backup-and-overwrite behavior is
  preserved; review screen shows a diff-style "changed vs current."
- **Registry file missing/corrupt:** treat as empty opt-out set; the hook fails open
  to silent (never blocks a CC session).

## Testing strategy

- **`registry`:** unit-test the full state matrix — managed/unmanaged × opted-in/out
  × `forge.yaml` present/absent.
- **`init-detect`:** fixture repos (node, python, rust, multi-repo) → expected
  `ConfigDraft` snapshots.
- **`session-hook`:** feed simulated SessionStart payloads; assert silent vs
  context-injecting vs nudge output.
- **`init-enrich`:** test the `ConfigDraft` contract both backends must satisfy;
  pin one recorded enrichment fixture for regression.
- **`review-render`:** snapshot the annotated screen from a known draft.

## Phasing (milestone → issues)

1. **Foundation** — `registry` module + `enable`/`disable`/`status` commands +
   marker handling. Unblocks the hook.
2. **Hook** — SessionStart hook install into `settings.json` + context injection +
   opt-out respect + unmanaged nudge.
3. **Autopilot brain** — `init-detect` refactor (`ConfigDraft` + confidence) →
   `init-enrich` skill upgrade → annotated `review-render` screen.
4. **Resilience** — BYO-key `api` enrichment backend + self-healing `validate` +
   `--manual` escape hatch.

All four phases ship in **one milestone**.

## Out of scope / non-goals

- Physically hiding global slash-commands per directory (see Pillar B constraint).
- A standalone web onboarding UI.
- Multi-user / team-shared registries (registry is per-machine, user-level).

## Open questions

- Exact confidence thresholds that trigger a TODO flag vs a silent default
  (tune during Phase 3).
- Whether the unmanaged-directory nudge defaults to on or off (lean: off, opt-in via
  a global setting) — decide in Phase 2.
