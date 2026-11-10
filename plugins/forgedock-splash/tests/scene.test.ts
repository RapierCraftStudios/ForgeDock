// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from 'claude-code/testing'
import { LAST, MIN_COLUMNS, MIN_ROWS, scene, setTheme } from '../hooks/scene'

test('every frame fits the smallest band the splash draws in, on both themes', async () => {
  for (const light of [false, true]) {
    setTheme(light)
    for (let f = 0; f <= LAST; f++) {
      const rows = scene(f)
      expect(rows.length <= MIN_ROWS).toBe(true)
      for (const runs of rows) {
        const width = runs.reduce((n, run) => n + [...run.text].length, 0)
        expect(width <= MIN_COLUMNS).toBe(true)
      }
    }
  }
  setTheme(false)
})

test('the scene draws the mark, Clawd and the wordmark once settled', async () => {
  const text = scene(LAST - 12).map(runs => runs.map(run => run.text).join('')).join('\n')
  expect(text.includes('▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄')).toBe(true)
  expect(text.includes('▐▛███▜▌')).toBe(true)
  expect(text.includes('F O R G E D O C K')).toBe(true)
  expect(text.includes('» supercharged')).toBe(true)
})
