# Design-System Linter — `scripts/design-system-lint.mjs`

> **Status:** Committed — the deterministic anti-slop gate for the UI Taste Harness (milestone #13, issue #884).
> Consumes the [`FORGE:DESIGN_SPEC` schema](design-spec-schema.md) (#881); enforces the machine-checkable
> negatives from the [reference corpus](reference-corpus.md) (#880); invoked by the
> render → critique loop (#882) and/or quality-gate.

## Purpose

The positive, deterministic floor of the harness. It **hard-fails** generated landing-page output that
violates the committed design system, rather than hoping prose prevents regression to generic AI defaults.

> Don't let the LLM "reason its way" back to generic defaults — **constrain it out of them deterministically**.
> Prose is a suggestion; a failing lint is a constraint. This raises the floor and never lets it regress,
> regardless of model variance. (Same philosophy as the #639 fix.)

The linter and the vision critic (#882) check the rendered output against the **same** committed intent
(the `FORGE:DESIGN_SPEC`). The linter owns the **deterministic** negatives; the critic owns the perceptual ones.

## Scope — what the linter owns

The [corpus](reference-corpus.md) tags each negative with its check surface. The linter implements exactly the
deterministic ones; the rest are left to the vision critic.

| Negative | Check | Default severity | Surface |
|---|---|---|---|
| **N1** | Purple/blue gradient hero on a white/near-white background | BLOCKING when spec opts in | `checkHeroGradient` |
| **N2** | Inter / system-default typeface at default weights as the display/body face | BLOCKING (typography is core taste) | `checkTypography` |
| **N4** | Exactly three identical feature cards (structural pattern only) | WARNING — icon judgement is the critic's | `checkRepeatedCards` |
| **N5** | A single radius applied to everything, or off-scale radii | BLOCKING when a multi-token `radius.scale` exists | `checkRadius` |
| **N6** | Default Tailwind palette (slate/gray/zinc/neutral/indigo/violet) used as the brand color | BLOCKING when `no-default-tailwind-palette` is set | `checkPalette` |
| **N7** | The boilerplate skeleton: hero → 3-cards → testimonial → CTA, in that order | BLOCKING when `layout_grammar.sections` exists | `checkSectionSkeleton` |
| **N24** | Static product mock: `product_mock.type` is committed (not `"none"`) but the rendered hero has a `.product-window` or `.mock-*` element with no `animation`, `transition`, or JS `addEventListener` present | BLOCKING when `product_mock.type` is set and not `"none"` | `checkProductMock` | <!-- Added: forge#1045 --> |
| — | Off-scale spacing (padding/margin/gap not on `spacing.scale`) | WARNING | `checkSpacing` |
| — | Contrast: `color.foreground` vs `color.background` below `acceptance.a11y.contrast_min` | BLOCKING when a contrast floor is declared | `checkContrast` |

**Opt-in trigger for N24**: `product_mock.type` present in spec and not `"none"`. When `product_mock.type: "none"`,
N24 is skipped entirely — the architect deliberately opted out of a mock, and no check is needed.

**Out of scope** (vision-critic-owned, #882): N3 (everything centered), N8 (stock illustration / generic 3D),
N9 (glassmorphism overuse), N10 (no visual hierarchy), N11 (abstract copy / no product shown),
N12 (decorative effects that serve nothing), N24 perceptual quality (whether the 2 interactions feel right — the critic
judges that; the linter only checks that interaction signals are present at all). These require perceptual judgement
and are not deterministically checkable.
N12 / effect justification specifically is governed by the [effects-appropriateness doctrine](effects-appropriateness.md) (#885)
and judged by the vision critic (#882) against the per-section `justification`; the perf gate (#875) owns the hard `budget`. The linter stays out.

## Spec-driven gating

Which checks **block** (vs. merely warn) is driven by the spec, not hardcoded — so the same linter serves any
archetype. A check escalates to `BLOCKING` when the spec opts in via:

- `color.rules` — e.g. `"no-default-tailwind-palette"` (gates N6/N1), `"contrast>=4.5"` (gates contrast).
- `negatives[]` — e.g. `"N6"`, `"N7"` (raw IDs, `{ "id": "N6" }` objects, or descriptive strings are all accepted).
- Presence of the relevant token field — a multi-entry `radius.scale` opts N5 in; `layout_grammar.sections` opts N7 in;
  a committed non-default `typography.display_family` opts N2 in; `acceptance.a11y.contrast_min` opts contrast in;
  `product_mock.type` set to any value other than `"none"` opts N24 in.

`--strict` forces **every** deterministic check to block regardless of spec opt-in.

## Usage

```bash
node scripts/design-system-lint.mjs --spec <spec.json> --html <page.html> [options]
```

| Option | Meaning |
|---|---|
| `--spec <path>` | The `FORGE:DESIGN_SPEC` JSON (required) |
| `--html <path>` | The generated HTML to lint (required, unless `--selftest`) |
| `--css <path>` | Optional separate CSS file (inline `<style>` and `style="…"` are always read) |
| `--baseline` | Report findings but always exit `0` (survey existing slop, never fail the build) |
| `--strict` | Every deterministic check blocks, even without spec opt-in |
| `--json` | Emit findings as JSON on stdout (for the #882 critique loop to consume) |
| `--selftest` | Run internal self-checks (contrast math, palette table) and exit |
| `--help` | Show usage |

### Output

Plain mode prints one finding per line with the established severity prefixes, then a summary:

```
BLOCKING: [N6] Committed color accent=#4f46e5 is a default Tailwind palette value — not a brand color.
WARNING:  [SPACING] Off-scale spacing value(s): 17px — not on spacing.scale [4, 8, 12, 16, 24, 32, 48, 64, 96].
OK:       [N1] No purple/blue-gradient-on-white hero detected.

=== Summary ===
Checks run: 13
Blocking: 11
Warnings: 1
```

`--json` emits `{ blocking, warnings, baseline, findings: [{ severity, negative, message }] }`.

### Exit codes

Matches the scripts-layer convention (`scripts/verify-env-vars.sh`):

| Code | Meaning |
|---|---|
| `0` | Pass — no blocking findings |
| `1` | Blocking findings present |
| `2` | Warnings only (or bad invocation) |

`--baseline` always exits `0`.

## Integration

- **Render → critique loop (#882):** call the linter with `--json` on the generated HTML before the vision pass.
  Blocking findings short-circuit the iteration (the page is regenerated against the spec) without spending a
  vision-critique turn. The linter is deterministic and dependency-free, so it is cheap to run every iteration.
- **quality-gate:** invoke as a sibling scripts-layer check (like `scripts/verify-*.sh`) and key off the exit code.
  Use `--baseline` for a non-failing survey, or default mode to hard-gate.

## Design notes

- **Zero runtime dependencies** — Node built-ins only (`node:fs`), matching `scripts/gen-logo.mjs`. HTML/CSS is
  scanned with tolerant regex (attribute order, quote style, and whitespace are accommodated); no jsdom/cheerio.
- **Injection-safe** — inputs are read as data and never interpolated into a shell; there is no `eval`/`exec`
  (avoids the class of review-findings #73 / #335).
- **Deterministic** — no network, no randomness, stable finding order. The contrast check uses the standard WCAG
  relative-luminance formula (self-tested: `#000`/`#fff` = 21:1).
- **Parser limitations** — being regex-based, the linter reads inline `<style>` blocks and `style="…"` attributes
  plus Tailwind utility classes; it does not resolve an external Tailwind build's computed colors. Ambiguous cases
  (e.g. a committed font that cannot be confirmed in the output) are reported as `WARNING`, not `BLOCKING`, to avoid
  false hard-fails. For computed/rendered-pixel checks (e.g. N8–N12), defer to the vision critic with a real render
  (Playwright, #875).
