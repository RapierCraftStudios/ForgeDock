// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
// GENERATED from plugins/forgedock-splash/hooks/scene.ts (types stripped) so `npx forgedock` can play the
// startup-splash scene on any supported Node, including from node_modules where Node refuses to strip types.
// Do not edit by hand: change scene.ts, then run: node scripts/gen-splash-scene.mjs
// bin/tests/splash-scene-parity.test.mjs fails if the two drift.
// Pure scene: frame number -> rows of coloured runs. No engine imports, so the
// same code drives the mod and the offline frame preview.

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
const HEART = '#ff6f91'
const STEAM = '#d8d3cb'
const FLAME_RED = '#c8200a'

/** Pick the palette for the terminal's theme (Claude Code's `theme` setting). */
export function setTheme(light         ) {
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
  // one claw up, swinging: a wave hello / goodbye
  waveA: [' ▐▛███▜▌▗', '▝▜█████▛ ', '  ▘▘ ▝▝  '],
  waveB: [' ▐▛███▜▌▝', '▝▜█████▛▖', '  ▘▘ ▝▝  '],
  // dizzy wobble after the bonk
  dizzyL: ['▐▀███▀▌  ', '▜█████▛▘ ', ' ▘▘ ▝▝   '],
  dizzyR: ['  ▐▀███▀▌', ' ▝▜█████▛', '   ▘▘ ▝▝ '],
}

// Beats (frame numbers).
const FORGE = 12 // the F is forged in, glowing then cooling
const WALK_END = FORGE + 18 // Clawd walks in under the overhang
const LOOK_END = WALK_END + 5 // looks up at the bar
const CROUCH_END = LOOK_END + 2
const BONK = CROUCH_END + 3 // head meets the bar
const LAND = BONK + 3
const DIZZY_END = LAND + 8 // stars circle Clawd's head, then it shakes it off
const SHINE_END = BONK + 18 // shine ring expands from the impact
const TYPE_START = BONK + 6
const TYPE_END = TYPE_START + WORD.length
const HOLD_START = TYPE_END + 4
const FADE_START = HOLD_START + 32
export const LAST = FADE_START + 10

const CLAWD_X = 21 // under the right end of the top bar, clear of the F's lower strokes
const START_X = CW // walks in from the right edge
const IMPACT = { r: TOP + 2, c: 25 } // underside of the top bar, above Clawd's head

const hex = (s        ) => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16))
export const mix = (a        , b        , t        ) => {
  const x = hex(a), y = hex(b), k = Math.max(0, Math.min(1, t))
  return '#' + x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * k).toString(16).padStart(2, '0')).join('')
}
const ramp = (stops          , t        ) => {
  const u = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(u))
  return mix(stops[i] ?? WHITE, stops[i + 1] ?? WHITE, u - i)
}
const easeOut = (t        ) => 1 - (1 - t) * (1 - t)
// Deterministic flicker noise in [0, 1).
const noise = (a        , b        ) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// Light comes from the upper left: faces open to the sky catch it, faces open to the floor fall into shade.
const blank = (r        , c        ) => (MARK[r]?.[c] ?? ' ') === ' '
function lit(r        , c        , base        )         {
  const grain = (noise(c * 0.7, r * 3.1) - 0.5) * 0.08 // brushed steel: faint horizontal streaks
  base = mix(base, CHROME[0] ?? WHITE, 0.3) // polished: lift the whole face toward the brightest stop
  let col = grain > 0 ? mix(base, CHROME[0] ?? WHITE, grain) : mix(base, CHROME[3] ?? WHITE, -grain)
  if (blank(r - 1, c)) col = mix(col, CHROME[0] ?? WHITE, 0.55) // top bevel highlight
  else if (blank(r, c - 1)) col = mix(col, CHROME[0] ?? WHITE, 0.3) // left bevel
  if (blank(r + 1, c)) col = mix(col, CHROME[3] ?? WHITE, 0.18) // underside in shade
  return col
}

function markColor(r        , c        , f        )                {
  const chrome = lit(r, c, ramp(CHROME, c / MW + r * 0.06))
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
  // Still warm: the underside keeps a faint, slowly breathing ember glow.
  const warm = Math.max(0, (r - 3) / 5) * (0.24 + 0.1 * Math.sin(f / 4 + c / 3))
  const settle = Math.min(1, (f - FORGE - 6) / 8)
  return warm > 0 && settle > 0 ? mix(chrome, EMBER[0] ?? WHITE, warm * settle) : chrome
}

// Upward-facing edges of the F: the blank cell just above each top surface is where flames lick.
const EDGES                                                = []
MARK.forEach((line, r) => [...line].forEach((ch, c) => {
  if (ch !== ' ' && (r === 0 || (MARK[r - 1]?.[c] ?? ' ') === ' ')) EDGES.push({ r: r - 1, c, age0: r * 0.6 + c })
}))

// How hot the fire is along an edge cell at frame f (0 = none, 1 = roaring).
function heat(e                                        , f        )         {
  let h = 0
  if (f < FORGE + 10) {
    const age = (f / FORGE) * (MW + 6) - e.age0 // same front that forges the mark
    if (age > 0) h = age < 6 ? 1 : Math.max(0, 1 - (age - 6) / 10)
  }
  const t = f - BONK
  if (t >= 0 && t < 6) h = Math.max(h, (1 - t / 6) * Math.max(0, 1 - Math.abs(e.c - IMPACT.c) / 7))
  if (f >= FORGE + 10) h = Math.max(h, 0.26) // a low, living flame once settled
  return h
}

function fire(f        , put                                            ) {
  const LV = ['░', '░', '▒', '▒', '▓', '▄']
  for (const e of EDGES) {
    const h = heat(e, f) * (0.55 + 0.45 * noise(e.c, Math.floor(f / 2)))
    if (h < 0.12) continue
    const i = Math.min(LV.length - 1, Math.floor(h * LV.length))
    // deep red at the base of the range, orange through the body, yellow only in the hottest core
    const color = h > 0.95 ? (EMBER[2] ?? WHITE) : ramp([FLAME_RED, EMBER[0] ?? WHITE, EMBER[1] ?? WHITE, EMBER[2] ?? WHITE], h * 0.8)
    put(e.r + TOP, e.c, { ch: LV[i] ?? '▁', color })
  }
}

// Fresh off the anvil: a puff of quench steam as the metal cools.
function steam(f        , put                                            ) {
  const t = f - (FORGE + 3)
  if (t < 0 || t > 12) return
  for (let i = 0; i < 6; i++) {
    const start = i * 1.5
    const a = t - start
    if (a < 0 || a > 7) continue
    const c = 13 + i * 3 + Math.round(Math.sin(a / 1.3 + i) * 1.2)
    const r = TOP - 1 + (a < 3 ? 1 : 0) // hugs the bar, then lifts into the headroom
    put(r, c, { ch: a < 5 ? '~' : '·', color: mix(STEAM, BG, a / 8) })
  }
}

// Embers drifting up off the mark.
function embers(f        , put                                            ) {
  if (f < FORGE + 4) return
  for (let i = 0; i < 9; i++) {
    const period = 16 + (i % 4) * 3
    const a = (f + i * 7) % period
    if (a > 9) continue
    const e = EDGES[Math.floor(noise(i, Math.floor((f + i * 7) / period)) * EDGES.length)]
    if (!e) continue
    const r = e.r + TOP - Math.floor(a / 2)
    const c = e.c + Math.round(Math.sin(a / 2 + i) * 1.4)
    const color = mix(EMBER[1] ?? WHITE, FLAME_RED, a / 9)
    put(r, c, { ch: a < 5 ? '•' : '·', color, bold: a < 5 })
  }
}

function clawd(f        )                                                     {
  if (f < FORGE) return null
  if (f < WALK_END) {
    const t = (f - FORGE) / (WALK_END - FORGE)
    const x = Math.round(START_X + (CLAWD_X - START_X) * easeOut(t))
    const step = Math.floor(f / 2) % 2
    return { x, lift: step, pose: step ? P.stepA : P.stepB } // a bouncy trot
  }
  if (f < LOOK_END) return { x: CLAWD_X, lift: 0, pose: P.look }
  if (f < CROUCH_END) return { x: CLAWD_X, lift: 0, pose: P.crouch }
  if (f < BONK) return { x: CLAWD_X, lift: Math.min(2, f - CROUCH_END + 1), pose: P.jump }
  if (f === BONK) return { x: CLAWD_X, lift: 2, pose: P.jump }
  if (f < LAND) return { x: CLAWD_X, lift: LAND - f, pose: P.jump }
  if (f === LAND) return { x: CLAWD_X, lift: 0, pose: P.crouch }
  if (f < DIZZY_END) return { x: CLAWD_X, lift: 0, pose: Math.floor((f - LAND) / 2) % 2 ? P.dizzyL : P.dizzyR }
  if (f < HOLD_START) {
    const k = (f - DIZZY_END) % 6
    return { x: CLAWD_X, lift: k === 2 || k === 3 ? 1 : 0, pose: P.cheer }
  }
  if (f >= FADE_START) return { x: CLAWD_X, lift: 0, pose: Math.floor(f / 2) % 2 ? P.waveA : P.waveB } // bye!
  // Idle: glance at the wordmark, wave hello, a happy hop, then a blink.
  const k = f - HOLD_START
  if (k >= 2 && k < 9) return { x: CLAWD_X, lift: 0, pose: P.side }
  if (k >= 10 && k < 20) return { x: CLAWD_X, lift: 0, pose: Math.floor(k / 2) % 2 ? P.waveA : P.waveB }
  if (k >= 21 && k < 25) return { x: CLAWD_X, lift: k === 22 || k === 23 ? 1 : 0, pose: P.cheer }
  return { x: CLAWD_X, lift: 0, pose: k === 27 || k === 28 ? P.blink : P.stand }
}

// Sparks thrown from the impact: analytic paths with a little gravity.
const SPARKS = [
  [1.2, -1.1], [2.2, -0.8], [3.2, -0.35], [3.8, 0.15], [2.8, 0.55], [1.6, 0.9], [4.4, -0.6], [0.6, -1.4],
]
function sparks(f        , put                                            ) {
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

// Little extras that make Clawd feel alive: a "!" when it spots the bar, dizzy stars, floating hearts.
function cute(f        , put                                                            ) {
  const head = H - 4 // the row just above Clawd's head when standing
  if (f >= WALK_END && f < LOOK_END) put(head, CLAWD_X + 4, { ch: '!', color: EMBER[2] ?? WHITE, bold: true }, true)
  if (f > LAND && f < DIZZY_END) {
    const a = (f - LAND) * 1.1
    for (const off of [0, Math.PI]) {
      const c = Math.round(CLAWD_X + 4 + Math.cos(a + off) * 3.5)
      put(head - (Math.sin(a + off) > 0.3 ? 1 : 0), c, { ch: '*', color: EMBER[2] ?? WHITE, bold: true }, true)
    }
  }
  // hearts float up and wobble out from Clawd while it cheers and waves
  for (let i = 0; i < 6; i++) {
    const born = DIZZY_END + 1 + i * 5
    const age = f - born
    if (age < 0 || age > 7 || born >= FADE_START) continue
    const r = head - Math.floor(age * 0.7)
    const c = CLAWD_X + 7 + (i % 2) + Math.round(Math.sin(age / 1.4 + i))
    const color = mix(HEART, BG, Math.max(0, (age - 4) / 4))
    put(r, c, { ch: age < 6 ? '♥' : '·', color, bold: age < 3 })
  }
}

export function scene(f        )          {
  const grid           = Array.from({ length: H }, () => Array.from({ length: CW }, () => ({ ch: ' ' })))
  const put = (r        , c        , cell      , over = false) => {
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

  // 2.5D depth: each forged cell casts a solid face to its right and below (light from the upper left).
  const depth = mix(CHROME[3] ?? WHITE, BG, 0.3)
  MARK.forEach((line, r) =>
    [...line].forEach((ch, c) => {
      if (ch === ' ' || !markColor(r, c, f)) return
      const face = f < FORGE + 6 ? mix(EMBER[0] ?? WHITE, BG, 0.5) : depth
      if (blank(r, c + 1)) put(r + TOP, c + 1, { ch: '▌', color: face })
      if (blank(r + 1, c) && (ch === '█' || ch === '▄')) put(r + TOP + 1, c + 1, { ch: '▀', color: face })
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
  fire(f, put)
  steam(f, put)
  sparks(f, put)
  embers(f, put)
  cute(f, put)

  // Fade everything to the background over the last beat.
  const fade = f >= FADE_START ? (f - FADE_START + 1) / (LAST - FADE_START + 1) : 0

  return grid.map(row => {
    const runs        = []
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
