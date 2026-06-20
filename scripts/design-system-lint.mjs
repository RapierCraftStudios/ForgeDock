#!/usr/bin/env node
/**
 * scripts/design-system-lint.mjs — ForgeDock deterministic design-system linter (anti-slop gate)
 *
 * The positive, deterministic floor of the UI Taste Harness (milestone #13, issue #884).
 * Hard-fails generated landing-page output that violates the committed FORGE:DESIGN_SPEC
 * (#881) by checking it against the machine-checkable "negatives" enumerated in the
 * reference corpus (#880). Prose in the spec is a suggestion; a failing lint is a constraint.
 *
 * Scope — DETERMINISTIC negatives only (the rest are vision-critic-owned, see #882):
 *   N1  Purple/blue gradient hero on a white/near-white background        (BLOCKING)
 *   N2  Inter / system-default font at default weights as display/body    (BLOCKING)
 *   N4  Exactly three identical feature cards (structural pattern only)    (WARNING — icon judgement is the critic's)
 *   N5  A single radius applied to everything / off-scale radii            (BLOCKING)
 *   N6  Default Tailwind palette (slate/gray/zinc/neutral/indigo) used as brand color (BLOCKING)
 *   N7  The boilerplate skeleton: hero → 3 cards → testimonial → CTA       (BLOCKING)
 *   --  Off-scale spacing (padding/margin/gap not on spacing.scale)        (WARNING)
 *   --  Contrast: foreground vs background below acceptance.a11y.contrast_min (BLOCKING)
 *
 * Which checks BLOCK is driven by the spec — a check only hard-fails when the spec opts in via
 * `color.rules` (e.g. "no-default-tailwind-palette", "contrast>=4.5") or `negatives[]` (e.g. "N6").
 * In `--strict` mode every deterministic check blocks regardless of spec opt-in.
 *
 * Zero runtime dependencies — Node built-ins only (matches scripts/gen-logo.mjs). No `eval`,
 * no shell interpolation of inputs (avoids the injection class of review-findings #73 / #335).
 *
 * Usage:
 *   node scripts/design-system-lint.mjs --spec <spec.json> --html <page.html> [options]
 *
 * Options:
 *   --spec <path>      Path to the FORGE:DESIGN_SPEC JSON (required)
 *   --html <path>      Path to the generated HTML file to lint (required, unless --selftest)
 *   --css <path>       Optional separate CSS file (otherwise inline <style> + style="" are read)
 *   --baseline         Report findings but always exit 0 (survey existing slop, never fail the build)
 *   --strict           Every deterministic check blocks, even if the spec did not opt in
 *   --json             Emit findings as a JSON array on stdout (for the #882 critique loop)
 *   --selftest         Run internal self-checks (contrast math, palette table) and exit
 *   --help             Show this help
 *
 * Exit codes (matches scripts/verify-env-vars.sh):
 *   0 = pass (no blocking findings)   1 = blocking findings   2 = warnings only
 *   --baseline always exits 0.
 *
 * Example:
 *   node scripts/design-system-lint.mjs --spec design-spec.json --html out/index.html
 *   node scripts/design-system-lint.mjs --spec design-spec.json --html out/index.html --json
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    spec: null,
    html: null,
    css: null,
    baseline: false,
    strict: false,
    json: false,
    selftest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--spec":
        opts.spec = argv[++i];
        break;
      case "--html":
        opts.html = argv[++i];
        break;
      case "--css":
        opts.css = argv[++i];
        break;
      case "--baseline":
        opts.baseline = true;
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--selftest":
        opts.selftest = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

const HELP = `
Usage: node scripts/design-system-lint.mjs --spec <spec.json> --html <page.html> [options]

Deterministic design-system linter (anti-slop gate, ForgeDock #884).
Hard-fails generated output that violates the committed FORGE:DESIGN_SPEC.

Options:
  --spec <path>   FORGE:DESIGN_SPEC JSON (required)
  --html <path>   Generated HTML to lint (required, unless --selftest)
  --css <path>    Optional separate CSS file
  --baseline      Report findings but always exit 0
  --strict        Every deterministic check blocks, even without spec opt-in
  --json          Emit findings as a JSON array on stdout
  --selftest      Run internal self-checks and exit
  --help          Show this help

Exit: 0 = pass, 1 = blocking, 2 = warnings only (--baseline always 0)
`;

// ---------------------------------------------------------------------------
// Default Tailwind palette (the N6 "tell"). These are the canonical Tailwind v3
// neutral/indigo hex families most often left in as the actual brand color.
// Used as a brand/background/foreground/accent value, they signal AI-slop.
// ---------------------------------------------------------------------------

const TAILWIND_DEFAULT_HEXES = new Set(
  [
    // slate
    "#f8fafc",
    "#f1f5f9",
    "#e2e8f0",
    "#cbd5e1",
    "#94a3b8",
    "#64748b",
    "#475569",
    "#334155",
    "#1e293b",
    "#0f172a",
    // gray
    "#f9fafb",
    "#f3f4f6",
    "#e5e7eb",
    "#d1d5db",
    "#9ca3af",
    "#6b7280",
    "#4b5563",
    "#374151",
    "#1f2937",
    "#111827",
    // zinc
    "#fafafa",
    "#f4f4f5",
    "#e4e4e7",
    "#d4d4d8",
    "#a1a1aa",
    "#71717a",
    "#52525b",
    "#3f3f46",
    "#27272a",
    "#18181b",
    // neutral
    "#f5f5f5",
    "#e5e5e5",
    "#d4d4d4",
    "#a3a3a3",
    "#737373",
    "#525252",
    "#404040",
    "#262626",
    "#171717",
    // indigo (the classic "AI gradient" accent)
    "#eef2ff",
    "#e0e7ff",
    "#c7d2fe",
    "#a5b4fc",
    "#818cf8",
    "#6366f1",
    "#4f46e5",
    "#4338ca",
    "#3730a3",
    "#312e81",
    // violet / purple (the "AI gradient" partner)
    "#8b5cf6",
    "#7c3aed",
    "#a78bfa",
    "#c4b5fd",
    "#a855f7",
    "#9333ea",
  ].map((h) => h.toLowerCase()),
);

// Tailwind class-name families that map to the default palette as a brand color.
const TAILWIND_DEFAULT_CLASS_RE =
  /\b(?:bg|text|from|via|to|border|ring)-(?:slate|gray|zinc|neutral|indigo|violet|purple)-(?:50|100|200|300|400|500|600|700|800|900|950)\b/g;

// ---------------------------------------------------------------------------
// Color utilities (WCAG contrast — standard relative-luminance formula)
// ---------------------------------------------------------------------------

function normalizeHex(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().toLowerCase();
  const m = h.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  if (m[1].length === 3) {
    h =
      "#" +
      m[1]
        .split("")
        .map((c) => c + c)
        .join("");
  }
  return h;
}

function hexToRgb(hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function relativeLuminance({ r, g, b }) {
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(hexA, hexB) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return null;
  const lA = relativeLuminance(a);
  const lB = relativeLuminance(b);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// A "white / near-white" background — used by the N1 hero-gradient check.
function isNearWhite(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return relativeLuminance(rgb) > 0.85;
}

// ---------------------------------------------------------------------------
// Findings model
// ---------------------------------------------------------------------------

const findings = [];

function record(severity, negative, message) {
  // severity: "BLOCKING" | "WARNING" | "OK"
  findings.push({ severity, negative, message });
}

// ---------------------------------------------------------------------------
// Spec helpers — which checks block is spec-driven
// ---------------------------------------------------------------------------

function specRules(spec) {
  const rules =
    spec.color && Array.isArray(spec.color.rules) ? spec.color.rules : [];
  return rules.map((r) => String(r).toLowerCase());
}

function specNegatives(spec) {
  const negs = Array.isArray(spec.negatives) ? spec.negatives : [];
  // Negatives may be raw IDs ("N6"), {id:"N6"} objects, or descriptive strings.
  return negs.map((n) => {
    if (typeof n === "string") return n.toLowerCase();
    if (n && typeof n === "object")
      return String(n.id || n.negative || "").toLowerCase();
    return "";
  });
}

// Decide blocking severity: a check blocks if (strict) OR the spec opted in.
function blockIf(optedIn, strict) {
  return optedIn || strict ? "BLOCKING" : "WARNING";
}

function specOptsIn(spec, { rule, negId }, strict) {
  if (strict) return true;
  const rules = specRules(spec);
  const negs = specNegatives(spec);
  if (rule && rules.some((r) => r.includes(rule))) return true;
  if (
    negId &&
    negs.some(
      (n) => n === negId.toLowerCase() || n.includes(negId.toLowerCase()),
    )
  )
    return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTML / CSS extraction helpers (tolerant regex scanning — zero deps)
// ---------------------------------------------------------------------------

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function extractInlineStyles(html) {
  // Concatenate <style>...</style> blocks + all style="..." attributes.
  let css = "";
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of styleBlocks) {
    css += block.replace(/<\/?style[^>]*>/gi, "") + "\n";
  }
  const styleAttrs = html.match(/style\s*=\s*"([^"]*)"/gi) || [];
  for (const attr of styleAttrs) {
    const m = attr.match(/style\s*=\s*"([^"]*)"/i);
    if (m) css += m[1] + ";\n";
  }
  return css;
}

function extractAllHex(text) {
  const hits = text.match(/#[0-9a-fA-F]{3,6}\b/g) || [];
  return hits.map((h) => h.toLowerCase()).filter((h) => normalizeHex(h));
}

function extractClassNames(html) {
  const out = [];
  const classAttrs = html.match(/class\s*=\s*"([^"]*)"/gi) || [];
  for (const attr of classAttrs) {
    const m = attr.match(/class\s*=\s*"([^"]*)"/i);
    if (m) out.push(...m[1].split(/\s+/).filter(Boolean));
  }
  return out;
}

// Convert a px / rem value string to a number of px (rem assumes 16px root).
function toPx(value, unit) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return null;
  if (unit === "rem" || unit === "em") return n * 16;
  return n;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// N6 — Default Tailwind palette used as the actual brand color.
function checkPalette(spec, html, css, strict) {
  const optedIn = specOptsIn(
    spec,
    { rule: "no-default-tailwind-palette", negId: "N6" },
    strict,
  );
  const sev = blockIf(optedIn, strict);

  // (a) Spec's own committed colors must not BE the default palette.
  const color = spec.color || {};
  const committed = [
    ["background", color.background],
    ["foreground", color.foreground],
    ["accent", color.accent],
    ...(color.supporting || []).map((c, i) => [`supporting[${i}]`, c]),
  ];
  let specHit = false;
  for (const [name, val] of committed) {
    const h = normalizeHex(val);
    if (h && TAILWIND_DEFAULT_HEXES.has(h)) {
      record(
        sev,
        "N6",
        `Committed color ${name}=${h} is a default Tailwind palette value — not a brand color.`,
      );
      specHit = true;
    }
  }

  // (b) Rendered HTML using default-palette Tailwind classes as brand surfaces.
  const classHits = html.match(TAILWIND_DEFAULT_CLASS_RE) || [];
  const uniqueClassHits = [...new Set(classHits)];
  if (uniqueClassHits.length > 0) {
    record(
      sev,
      "N6",
      `Default Tailwind palette used as brand color via ${uniqueClassHits.length} class family/families: ${uniqueClassHits.slice(0, 8).join(", ")}${uniqueClassHits.length > 8 ? ", …" : ""}.`,
    );
    specHit = true;
  }

  // (c) Raw default-palette hexes in inline CSS used as fills/backgrounds.
  const cssHexes = new Set(extractAllHex(css));
  const cssDefaultHexes = [...cssHexes].filter((h) =>
    TAILWIND_DEFAULT_HEXES.has(h),
  );
  if (cssDefaultHexes.length > 0) {
    record(
      sev,
      "N6",
      `Default Tailwind palette hex(es) in styles: ${cssDefaultHexes.slice(0, 8).join(", ")}.`,
    );
    specHit = true;
  }

  if (!specHit)
    record("OK", "N6", "No default-Tailwind-palette brand color detected.");
}

// N2 — Inter / system-default font at default weights everywhere.
function checkTypography(spec, html, css, strict) {
  const optedIn =
    specOptsIn(spec, { rule: "non-default-typeface", negId: "N2" }, strict) ||
    // typography is core taste — block by default when a non-default family was committed.
    (spec.typography &&
      spec.typography.display_family &&
      !/inter|system|sans-serif/i.test(spec.typography.display_family));
  const sev = blockIf(optedIn, strict);

  const haystack = (css + " " + html).toLowerCase();
  const DEFAULTS = [
    "inter",
    "system-ui",
    "-apple-system",
    "blinkmacsystemfont",
    "segoe ui",
    "arial",
    "helvetica",
  ];

  // (a) Spec committed a default family as the display/body face.
  const typ = spec.typography || {};
  for (const [name, fam] of [
    ["display_family", typ.display_family],
    ["body_family", typ.body_family],
  ]) {
    if (fam && DEFAULTS.some((d) => String(fam).toLowerCase().includes(d))) {
      record(
        sev,
        "N2",
        `Spec ${name}="${fam}" is a default/system typeface — the Inter-at-default tell.`,
      );
    }
  }

  // (b) Rendered output declares a default family as the primary font.
  const declaredFamilies = (
    css.match(/font-family\s*:\s*([^;}\n]+)/gi) || []
  ).map((d) => d.replace(/font-family\s*:\s*/i, "").toLowerCase());
  const usesDefault = declaredFamilies.some((d) => {
    const first = d.split(",")[0].replace(/['"]/g, "").trim();
    return DEFAULTS.some((def) => first.includes(def));
  });
  const committedDisplay = typ.display_family
    ? String(typ.display_family).toLowerCase()
    : null;
  const committedPresent =
    committedDisplay &&
    !DEFAULTS.some((d) => committedDisplay.includes(d)) &&
    haystack.includes(
      committedDisplay.replace(/['"]/g, "").split(",")[0].trim(),
    );

  if (usesDefault && !committedPresent) {
    record(
      sev,
      "N2",
      "Rendered output uses a default/system font-family as the primary face, and the committed non-default display family is absent.",
    );
  } else if (
    !committedPresent &&
    committedDisplay &&
    !DEFAULTS.some((d) => committedDisplay.includes(d))
  ) {
    record(
      "WARNING",
      "N2",
      `Committed display family "${typ.display_family}" not found in rendered output — verify the font is actually applied.`,
    );
  } else {
    record("OK", "N2", "Committed non-default typeface appears to be applied.");
  }
}

// N5 — Single radius applied to everything / off-scale radii.
function checkRadius(spec, html, css, strict) {
  const optedIn =
    specOptsIn(spec, { rule: "radius-system", negId: "N5" }, strict) ||
    (spec.radius &&
      Array.isArray(spec.radius.scale) &&
      spec.radius.scale.length > 1);
  const sev = blockIf(optedIn, strict);

  const scale =
    spec.radius && Array.isArray(spec.radius.scale)
      ? spec.radius.scale.map(Number)
      : null;

  // Collect radii from CSS (border-radius) + Tailwind rounded-* classes.
  const cssRadii = [];
  for (const m of css.matchAll(/border-radius\s*:\s*([0-9.]+)(px|rem|em)/gi)) {
    const px = toPx(m[1], m[2].toLowerCase());
    if (px !== null) cssRadii.push(px);
  }
  const roundedClasses =
    html.match(/\brounded(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?\b/g) || [];

  // (a) Off-scale radii in CSS.
  if (scale) {
    const offScale = [...new Set(cssRadii)].filter(
      (r) => r !== 0 && !scale.includes(r),
    );
    if (offScale.length > 0) {
      record(
        sev,
        "N5",
        `Off-scale border-radius value(s): ${offScale.join(", ")}px — not in spec radius.scale [${scale.join(", ")}].`,
      );
    }
  }

  // (b) Single radius applied to everything (the rounded-2xl-on-all tell).
  const uniqueRounded = [...new Set(roundedClasses)];
  if (
    roundedClasses.length >= 4 &&
    uniqueRounded.length === 1 &&
    uniqueRounded[0] !== "rounded-none"
  ) {
    record(
      sev,
      "N5",
      `Single radius "${uniqueRounded[0]}" applied to ${roundedClasses.length} elements — no deliberate radius system (rounded-everything tell).`,
    );
  } else if (
    scale &&
    [...new Set(cssRadii)].filter((r) => r !== 0).length === 1 &&
    cssRadii.length >= 4
  ) {
    record(
      sev,
      "N5",
      `Single border-radius value applied to ${cssRadii.length} elements — no deliberate radius system.`,
    );
  } else {
    record(
      "OK",
      "N5",
      "Radius usage looks deliberate (multiple tokens or within scale).",
    );
  }
}

// Off-scale spacing (padding/margin/gap not on spacing.scale).
function checkSpacing(spec, html, css, strict) {
  const scale =
    spec.spacing && Array.isArray(spec.spacing.scale)
      ? spec.spacing.scale.map(Number)
      : null;
  if (!scale) {
    record(
      "OK",
      "SPACING",
      "No spacing.scale in spec — skipping off-scale spacing check.",
    );
    return;
  }
  const optedIn = specOptsIn(
    spec,
    { rule: "spacing-on-scale", negId: "SPACING" },
    strict,
  );
  const sev = blockIf(optedIn, false); // spacing is a rhythm WARNING unless explicitly opted in

  const values = new Set();
  for (const m of css.matchAll(
    /(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?\s*:\s*([0-9.]+)(px|rem|em)/gi,
  )) {
    const px = toPx(m[1], m[2].toLowerCase());
    if (px !== null && px !== 0) values.add(px);
  }
  const offScale = [...values].filter((v) => !scale.includes(v));
  if (offScale.length > 0) {
    record(
      sev,
      "SPACING",
      `Off-scale spacing value(s): ${offScale.slice(0, 12).join(", ")}px — not on spacing.scale [${scale.join(", ")}].`,
    );
  } else {
    record(
      "OK",
      "SPACING",
      "All measured spacing values are on-scale (or none found in inline CSS).",
    );
  }
}

// Contrast — foreground vs background below acceptance.a11y.contrast_min.
function checkContrast(spec, strict) {
  const color = spec.color || {};
  const fg = color.foreground;
  const bg = color.background;
  const a11y = (spec.acceptance && spec.acceptance.a11y) || {};
  const min = Number(a11y.contrast_min) || 4.5;

  const optedIn =
    specOptsIn(spec, { rule: "contrast", negId: "CONTRAST" }, strict) ||
    a11y.contrast_min !== undefined;
  const sev = blockIf(optedIn, strict);

  if (!fg || !bg) {
    record(
      "WARNING",
      "CONTRAST",
      "Spec missing color.foreground or color.background — cannot compute contrast.",
    );
    return;
  }
  const ratio = contrastRatio(fg, bg);
  if (ratio === null) {
    record(
      "WARNING",
      "CONTRAST",
      `Could not parse color.foreground (${fg}) / color.background (${bg}) as hex.`,
    );
    return;
  }
  if (ratio < min) {
    record(
      sev,
      "CONTRAST",
      `Contrast ${ratio.toFixed(2)}:1 (fg ${fg} on bg ${bg}) is below the required ${min}:1.`,
    );
  } else {
    record(
      "OK",
      "CONTRAST",
      `Contrast ${ratio.toFixed(2)}:1 meets the ${min}:1 floor.`,
    );
  }
}

// N7 — The boilerplate skeleton: hero → 3 cards → testimonial → CTA.
function checkSectionSkeleton(spec, html, strict) {
  const optedIn =
    specOptsIn(spec, { rule: "non-boilerplate-layout", negId: "N7" }, strict) ||
    (spec.layout_grammar && Array.isArray(spec.layout_grammar.sections));
  const sev = blockIf(optedIn, strict);

  // Derive an ordered list of section identities from the rendered HTML.
  const sectionIds = [];
  for (const m of html.matchAll(/<section\b[^>]*\bid\s*=\s*"([^"]+)"/gi)) {
    sectionIds.push(m[1].toLowerCase());
  }
  // Fall back to data-section / aria-label hints if no ids.
  if (sectionIds.length === 0) {
    for (const m of html.matchAll(
      /<section\b[^>]*\b(?:data-section|aria-label)\s*=\s*"([^"]+)"/gi,
    )) {
      sectionIds.push(m[1].toLowerCase());
    }
  }

  const looksLike = (id, kinds) => kinds.some((k) => id.includes(k));
  // The exact boilerplate signature, in order.
  const SKELETON = [
    ["hero"],
    ["feature", "card", "benefit"],
    ["testimonial", "quote", "review"],
    ["cta", "call-to-action", "signup", "get-started"],
  ];

  if (sectionIds.length >= 4) {
    // Find whether the first four meaningful sections match the skeleton in order.
    let idx = 0;
    let matched = 0;
    for (const id of sectionIds) {
      if (idx < SKELETON.length && looksLike(id, SKELETON[idx])) {
        matched++;
        idx++;
      }
    }
    if (matched === SKELETON.length && idx === SKELETON.length) {
      record(
        sev,
        "N7",
        `Boilerplate section skeleton detected: hero → 3-cards → testimonial → CTA (order: ${sectionIds.join(" → ")}).`,
      );
      return;
    }
  }

  // Also flag if the spec's own committed layout_grammar IS the skeleton.
  const specSections =
    spec.layout_grammar && Array.isArray(spec.layout_grammar.sections)
      ? spec.layout_grammar.sections.map((s) =>
          String(s.id || "").toLowerCase(),
        )
      : [];
  if (specSections.length >= 4) {
    let idx = 0,
      matched = 0;
    for (const id of specSections) {
      if (idx < SKELETON.length && looksLike(id, SKELETON[idx])) {
        matched++;
        idx++;
      }
    }
    if (matched === SKELETON.length && idx === SKELETON.length) {
      record(
        sev,
        "N7",
        `Spec layout_grammar.sections IS the boilerplate skeleton (hero → 3-cards → testimonial → CTA).`,
      );
      return;
    }
  }

  record(
    "OK",
    "N7",
    "Section sequence is not the hero → 3-cards → testimonial → CTA boilerplate.",
  );
}

// N1 — Purple/blue gradient hero on a white/near-white background.
function checkHeroGradient(spec, html, css, strict) {
  const optedIn = specOptsIn(
    spec,
    { rule: "no-default-tailwind-palette", negId: "N1" },
    strict,
  );
  const sev = blockIf(optedIn, strict);

  // Isolate the hero region if identifiable; otherwise scan the top of the document.
  let heroBlock = "";
  const heroMatch = html.match(
    /<section\b[^>]*\b(?:id|class|data-section)\s*=\s*"[^"]*hero[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
  );
  if (heroMatch) heroBlock = heroMatch[0];
  else heroBlock = html.slice(0, 4000); // top of page as a heuristic hero proxy

  const heroLower = heroBlock.toLowerCase();
  const heroCssHexes = extractAllHex(heroBlock + " " + css);

  const hasGradient =
    /gradient\(/.test(heroLower) ||
    /\b(?:bg-gradient-to-[a-z]+)\b/.test(heroLower);
  const hasPurpleBlue =
    /\b(?:from|via|to|bg)-(?:indigo|violet|purple|blue|fuchsia)-(?:300|400|500|600|700)\b/.test(
      heroLower,
    ) ||
    heroCssHexes.some((h) => {
      const rgb = hexToRgb(h);
      if (!rgb) return false;
      // crude "purple/blue" test: blue dominant and red present (violet) or strongly blue.
      return rgb.b > 150 && rgb.b > rgb.g && rgb.b >= rgb.r;
    });

  // White-ish page/hero background.
  const bgWhite =
    isNearWhite(spec.color && spec.color.background) ||
    /\bbg-white\b/.test(heroLower) ||
    extractAllHex(heroBlock).some((h) => isNearWhite(h));

  if (hasGradient && hasPurpleBlue && bgWhite) {
    record(
      sev,
      "N1",
      "Purple/blue gradient hero on a white/near-white background — the classic AI-gradient tell.",
    );
  } else if (hasGradient && hasPurpleBlue) {
    record(
      "WARNING",
      "N1",
      "Purple/blue gradient detected in the hero region — verify it is earned (background is not white).",
    );
  } else {
    record("OK", "N1", "No purple/blue-gradient-on-white hero detected.");
  }
}

// N4 — Three identical feature cards (structural pattern only; icon judgement is the critic's).
function checkRepeatedCards(spec, html) {
  // Look for a feature/cards grid containing exactly three structurally-similar children.
  // Heuristic: a container whose direct repeated child class appears exactly 3 times.
  const classNames = extractClassNames(html);
  const counts = new Map();
  for (const c of classNames) {
    // focus on card-like class names
    if (/(?:card|feature|tile|benefit)/i.test(c)) {
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  const triples = [...counts.entries()]
    .filter(([, n]) => n === 3)
    .map(([c]) => c);
  if (triples.length > 0) {
    record(
      "WARNING",
      "N4",
      `Exactly three identical card-like elements (class "${triples[0]}") — the 3-feature-cards structural tell. Vision critic (#882) judges the icons.`,
    );
  } else {
    record(
      "OK",
      "N4",
      "No exactly-three-identical-cards structural pattern detected.",
    );
  }
}

// ---------------------------------------------------------------------------
// Self-test (contrast math + palette table sanity)
// ---------------------------------------------------------------------------

function selftest() {
  const cases = [
    ["#000000", "#ffffff", 21, "black/white"],
    ["#ffffff", "#ffffff", 1, "white/white"],
    ["#777777", "#ffffff", 4.48, "gray/white ~4.48"],
  ];
  let ok = true;
  for (const [a, b, expected, label] of cases) {
    const got = contrastRatio(a, b);
    const pass = Math.abs(got - expected) < 0.05;
    if (!pass) ok = false;
    console.log(
      `${pass ? "OK" : "FAIL"}: contrast ${label} expected ~${expected}, got ${got.toFixed(2)}`,
    );
  }
  // Palette table: indigo-600 must be flagged.
  const indigo = TAILWIND_DEFAULT_HEXES.has("#4f46e5");
  console.log(
    `${indigo ? "OK" : "FAIL"}: indigo-600 (#4f46e5) in default-palette table`,
  );
  if (!indigo) ok = false;
  // 3-digit hex normalization.
  const norm = normalizeHex("#fff") === "#ffffff";
  console.log(`${norm ? "OK" : "FAIL"}: 3-digit hex normalization`);
  if (!norm) ok = false;
  return ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(String(e.message) + "\n" + HELP);
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (opts.selftest) {
    const ok = selftest();
    process.exit(ok ? 0 : 1);
  }

  if (!opts.spec || !opts.html) {
    process.stderr.write("ERROR: --spec and --html are required.\n" + HELP);
    process.exit(2);
  }

  let spec, htmlRaw;
  try {
    spec = JSON.parse(readFileSync(opts.spec, "utf8"));
  } catch (e) {
    process.stderr.write(
      `ERROR: could not read/parse --spec ${opts.spec}: ${e.message}\n`,
    );
    process.exit(2);
  }
  try {
    htmlRaw = readFileSync(opts.html, "utf8");
  } catch (e) {
    process.stderr.write(
      `ERROR: could not read --html ${opts.html}: ${e.message}\n`,
    );
    process.exit(2);
  }

  const html = stripComments(htmlRaw);
  let css = extractInlineStyles(htmlRaw);
  if (opts.css) {
    try {
      css += "\n" + readFileSync(opts.css, "utf8");
    } catch {
      /* optional */
    }
  }

  // Run all deterministic checks.
  checkPalette(spec, html, css, opts.strict);
  checkTypography(spec, html, css, opts.strict);
  checkRadius(spec, html, css, opts.strict);
  checkSpacing(spec, html, css, opts.strict);
  checkContrast(spec, opts.strict);
  checkSectionSkeleton(spec, html, opts.strict);
  checkHeroGradient(spec, html, css, opts.strict);
  checkRepeatedCards(spec, html);

  const blocking = findings.filter((f) => f.severity === "BLOCKING");
  const warnings = findings.filter((f) => f.severity === "WARNING");

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          blocking: blocking.length,
          warnings: warnings.length,
          baseline: opts.baseline,
          findings,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    for (const f of findings) {
      process.stdout.write(`${f.severity}: [${f.negative}] ${f.message}\n`);
    }
    process.stdout.write("\n=== Summary ===\n");
    process.stdout.write(`Checks run: ${findings.length}\n`);
    process.stdout.write(`Blocking: ${blocking.length}\n`);
    process.stdout.write(`Warnings: ${warnings.length}\n`);
    if (opts.baseline)
      process.stdout.write("Mode: --baseline (reporting only, exit 0)\n");
  }

  if (opts.baseline) process.exit(0);
  if (blocking.length > 0) process.exit(1);
  if (warnings.length > 0) process.exit(2);
  process.exit(0);
}

main();
