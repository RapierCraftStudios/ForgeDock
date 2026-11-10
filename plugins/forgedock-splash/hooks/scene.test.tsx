import { expect, test } from 'claude-code/testing'
import { DURATION_MS, HEIGHT, WIDTH, frame, frameText } from './scene.mjs'

test('every frame of both themes fits the band, the settled one has the mark, Clawd and the wordmark', async () => {
  for (const theme of ['dark', 'light'] as const) {
    for (let ms = 0; ms <= DURATION_MS; ms += 50) {
      const f = frame(ms, theme)
      expect(f.cells.length).toBe(HEIGHT)
      expect(f.cells.every(row => row.length === WIDTH)).toBe(true)
    }
    const text = frameText(frame(5500, theme)).join('\n')
    expect(text).toContain('▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄')
    expect(text).toContain('▐█▀█▀█▌')
    expect(text).toContain('F O R G E D O C K')
  }
})
