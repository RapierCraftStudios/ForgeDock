// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure scene: frame number -> rows of coloured runs. No engine imports, so the
// same code drives the mod and the offline frame preview.

export type Run = { text: string; color?: string; bold?: boolean }
type Cell = { ch: string; color?: string; bold?: boolean }

export const TICK = 60

// The ForgeDock "F" mark, exactly as the CLI draws it (bin/cinema.mjs HERO_MARK).
const MARK = [
  '            ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
  '        ▄▄██████████████████',
  '     ▄█████████████▀▀▀▀▀▀▀▀▀',
  '   ▄██████████▀▀',
  '    ▀▀▀▀▀  ▄▄███████▀',
  '        ▄████████▀',
  '      ▄██████▀',
  '       ▀▀▀▀',
]
const MW = 28 // mark width
const TOP = 1 // canvas row of the mark's first row (row 0 is headroom for sparks)
const H = MARK.length + TOP
const CW = 56 // canvas width
const TEXT_X = 33 // column of the wordmark block

// Brand stops (bin/cinema.mjs) and Claude's orange for the mascot.
const DARK = { chrome: ['#f7f3ea', '#d9cfba', '#a99a82', '#6e6252'], ember: ['#ff4d00', '#ff8c1a', '#ffd166'], hot: '#ffffff', bg: '#1a1714' }
// Light terminals: a darker steel and deeper embers so the mark reads on white; the "white-hot" flash becomes bright orange.
const LIGHT = { chrome: ['#6e6252', '#5c5144', '#4a4136', '#2f2922'], ember: ['#c43c00', '#e06600', '#f29d00'], hot: '#ff7a00', bg: '#f4f1ec' }
let CHROME = DARK.chrome
let EMBER = DARK.ember
let WHITE = DARK.hot
let BG = DARK.bg
const CLAUDE = '#d97757'

/** Pick the palette for the terminal's theme (Claude Code's `theme` setting). */
export function setTheme(light: boolean) {
  const t = light ? LIGHT : DARK
  CHROME = t.chrome
  EMBER = t.ember
  WHITE = t.hot
  BG = t.bg
}

/** Smallest band the scene fits in. */
export const MIN_COLUMNS = 56
export const MIN_ROWS = 9
const WORD = 'F O R G E D O C K'

// Clawd poses (3 rows, 9 wide).
const P = {
  stand: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  stepA: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘  ▝▝ '],
  stepB: [' ▐▛███▜▌ ', '▝▜█████▛▘', ' ▘▘  ▝▝  '],
  look: [' ▐▀███▀▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  blink: [' ▐█████▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  side: [' ▐█▜██▛▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  crouch: ['         ', ' ▐▛███▜▌ ', '▀▀█████▀▀'],
  jump: ['▗▐▀███▀▌▖', ' ▜█████▛ ', '  ▝▘ ▝▘  '],
  cheer: ['▗▐▛███▜▌▖', ' ▜█████▛ ', '  ▘▘ ▝▝  '],
}

// Beats (frame numbers).
const FORGE = 12 // the F is forged in, glowing then cooling
const WALK_END = FORGE + 18 // Clawd walks in under the overhang
const LOOK_END = WALK_END + 5 // looks up at the bar
const CROUCH_END = LOOK_END + 2
const BONK = CROUCH_END + 3 // head meets the bar
const LAND = BONK + 3
const SHINE_END = BONK + 18 // shine ring expands from the impact
const TYPE_START = BONK + 6
const TYPE_END = TYPE_START + WORD.length
const HOLD_START = TYPE_END + 4
const FADE_START = HOLD_START + 32
export const LAST = FADE_START + 10

const CLAWD_X = 21 // under the right end of the top bar, clear of the F's lower strokes
const START_X = CW // walks in from the right edge
const IMPACT = { r: TOP + 2, c: 25 } // underside of the top bar, above Clawd's head

const hex = (s: string) => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16))
export const mix = (a: string, b: string, t: number) => {
  const x = hex(a), y = hex(b), k = Math.max(0, Math.min(1, t))
  return '#' + x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * k).toString(16).padStart(2, '0')).join('')
}
const ramp = (stops: string[], t: number) => {
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(u))
  return mix(stops[i] ?? WHITE, stops[i + 1] ?? WHITE, u - i)
}
const easeOut = (t: number) => 1 - (1 - t) * (1 - t)

function markColor(r: number, c: number, f: number): string | null {
  const chrome = ramp(CHROME, c / MW + r * 0.06)
  if (f < FORGE + 6) {
    const age = (f / FORGE) * (MW + 6) - r * 0.6 - c
    if (age < 0) return null
    if (age < 1.5) return EMBER[2] ?? WHITE
    if (age < 3) return EMBER[1] ?? WHITE
    if (age < 5) return EMBER[0] ?? WHITE
    return mix(EMBER[0] ?? WHITE, chrome, (age - 5) / 5)
  }
  if (f >= BONK && f < SHINE_END) {
    const t = f - BONK
    const dr = (r + TOP - IMPACT.r) * 2 // rows are ~2x taller than columns are wide
    const dist = Math.sqrt(dr * dr + (c - IMPACT.c) ** 2)
    if (t < 2 && dist < 2.6) return WHITE // a small flash right at the point of impact
    if (t < 7 && dist < 4) {
      // the struck spot glows hot, then fades straight back to chrome (no muddy brown)
      const heat = t < 4 ? (EMBER[2] ?? WHITE) : (EMBER[1] ?? WHITE)
      return mix(heat, chrome, Math.min(1, (t - 2) / 4 + dist / 6))
    }
    const radius = (t - 1) * 2.4
    const d = Math.abs(dist - radius)
    if (d < 1.2) return WHITE
    if (d < 3) return mix(WHITE, chrome, (d - 1.2) / 1.8)
  }
  return chrome
}

function clawd(f: number): { x: number; lift: number; pose: string[] } | null {
  if (f < FORGE) return null
  if (f < WALK_END) {
    const t = (f - FORGE) / (WALK_END - FORGE)
    const x = Math.round(START_X + (CLAWD_X - START_X) * easeOut(t))
    return { x, lift: 0, pose: Math.floor(f / 2) % 2 ? P.stepA : P.stepB }
  }
  if (f < LOOK_END) return { x: CLAWD_X, lift: 0, pose: P.look }
  if (f < CROUCH_END) return { x: CLAWD_X, lift: 0, pose: P.crouch }
  if (f < BONK) return { x: CLAWD_X, lift: Math.min(2, f - CROUCH_END + 1), pose: P.jump }
  if (f === BONK) return { x: CLAWD_X, lift: 2, pose: P.jump }
  if (f < LAND) return { x: CLAWD_X, lift: LAND - f, pose: P.jump }
  if (f === LAND) return { x: CLAWD_X, lift: 0, pose: P.crouch }
  if (f < HOLD_START) {
    const k = (f - LAND) % 6
    return { x: CLAWD_X, lift: k === 2 || k === 3 ? 1 : 0, pose: P.cheer }
  }
  // Idle: glance at the wordmark, a happy hop, then a blink.
  const k = f - HOLD_START
  if (k >= 4 && k < 14) return { x: CLAWD_X, lift: 0, pose: P.side }
  if (k >= 16 && k < 20) return { x: CLAWD_X, lift: k === 17 || k === 18 ? 1 : 0, pose: P.cheer }
  return { x: CLAWD_X, lift: 0, pose: k === 24 || k === 25 ? P.blink : P.stand }
}

// Sparks thrown from the impact: analytic paths with a little gravity.
const SPARKS = [
  [1.2, -1.1], [2.2, -0.8], [3.2, -0.35], [3.8, 0.15], [2.8, 0.55], [1.6, 0.9], [4.4, -0.6], [0.6, -1.4],
]
function sparks(f: number, put: (r: number, c: number, cell: Cell) => void) {
  const t = f - BONK
  if (t < 1 || t > 11) return
  // Plain glyphs every terminal font has.
  const glyph = ['*', '*', '*', '+', '+', '+', '•', '•', '·', '·', '.', '.'][t] ?? '.'
  const color = t < 3 ? WHITE : t < 5 ? (EMBER[2] ?? WHITE) : t < 8 ? (EMBER[1] ?? WHITE) : (EMBER[0] ?? WHITE)
  for (const [vx, vy] of SPARKS) {
    const c = Math.round(IMPACT.c + 2 + (vx ?? 0) * t * 1.3)
    const r = Math.round(IMPACT.r + (vy ?? 0) * t * 0.6 + 0.05 * t * t)
    put(r, c, { ch: glyph, color, bold: t < 4 })
  }
}

export function scene(f: number): Run[][] {
  const grid: Cell[][] = Array.from({ length: H }, () => Array.from({ length: CW }, () => ({ ch: ' ' })))
  const put = (r: number, c: number, cell: Cell, over = false) => {
    const row = grid[r]
    if (!row || c < 0 || c >= CW) return
    if (!over && row[c]?.ch !== ' ') return
    row[c] = cell
  }

  MARK.forEach((line, r) =>
    [...line].forEach((ch, c) => {
      if (ch === ' ') return
      const color = markColor(r, c, f)
      if (color) put(r + TOP, c, { ch, color })
    }),
  )

  // Wordmark block: letters land white-hot and cool to ember.
  if (f >= TYPE_START) {
    const n = Math.min(WORD.length, f - TYPE_START + 1)
    ;[...WORD.slice(0, n)].forEach((ch, i) => {
      const age = f - TYPE_START - i
      const settled = ramp(EMBER, i / WORD.length)
      put(TOP + 2, TEXT_X + i, { ch, color: age < 1 ? WHITE : age < 3 ? mix(WHITE, settled, age / 3) : settled, bold: true })
    })
  }
  if (f >= TYPE_END) [...'for Claude Code'].forEach((ch, i) => put(TOP + 3, TEXT_X + i, { ch, color: CLAUDE, bold: true }))
  if (f >= HOLD_START) {
    const pulse = ramp(EMBER, 0.5 + 0.5 * Math.sin((f - HOLD_START) / 3))
    ;[...'» supercharged'].forEach((ch, i) => put(TOP + 5, TEXT_X + i, { ch, color: pulse, bold: true }))
  }

  const cd = clawd(f)
  if (cd) {
    const top = H - 3 - cd.lift
    cd.pose.forEach((line, i) =>
      [...line].forEach((ch, j) => {
        if (ch !== ' ') put(top + i, cd.x + j, { ch, color: CLAUDE }, true)
      }),
    )
  }
  sparks(f, put)

  // Fade everything to the background over the last beat.
  const fade = f >= FADE_START ? (f - FADE_START + 1) / (LAST - FADE_START + 1) : 0

  return grid.map(row => {
    const runs: Run[] = []
    for (const cell of row) {
      const color = cell.color && fade > 0 ? mix(cell.color, BG, fade) : cell.color
      const last = runs[runs.length - 1]
      if (last && last.color === color && last.bold === cell.bold) last.text += cell.ch
      else runs.push({ text: cell.ch, color, bold: cell.bold })
    }
    // Drop trailing blanks so the band is no wider than it needs to be.
    while (runs.length && !runs[runs.length - 1]?.color && !runs[runs.length - 1]?.text.trim()) runs.pop()
    return runs
  })
}
