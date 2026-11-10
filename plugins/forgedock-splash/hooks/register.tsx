// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Frame } from '../types'
import { LAST, MIN_COLUMNS, MIN_ROWS, TICK, scene, setTheme } from './scene'

// -1 = hidden. Frames advance every TICK ms; the band clears after the last one.
const frame = atom({ plugin: 'forgedock-splash', key: 'frame' } as const, -1 as Frame)

export const register: Register = on => {
  // Play on a fresh launch only: not after /clear, not on a resumed session.
  let skipNext = false
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') skipNext = true
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (e.surface !== 'terminal' || !e.isInteractive) return result
    if (skipNext) {
      skipNext = false
      return result
    }
    const { startedAt } = await $.session.usage()
    if ((await $.clock.now()) - startedAt > 15_000) return result // a resumed session

    const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
    setTheme(typeof theme === 'string' && theme.startsWith('light'))

    await update($, frame, () => 0)
    const timer = $.clock.every(TICK, async () => {
      const f = await read($, frame)
      if (f < 0 || f >= LAST) {
        timer.cancel()
        await update($, frame, () => -1)
        return
      }
      await update($, frame, () => f + 1)
    })
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, frame)
    if (f < 0 || e.props.hasSurvey) return next(e)
    // Get out of the way: once work starts, or when the band is too small to draw the scene whole.
    if (e.props.isWorking || e.props.bodyColumns < MIN_COLUMNS || e.props.maxRows < MIN_ROWS) {
      await update($, frame, () => -1)
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {scene(f).map((runs, r) => (
          <Box key={`r${r}`}>
            {runs.length === 0 ? (
              <Text>{' '}</Text>
            ) : (
              runs.map((run, i) =>
                run.color ? (
                  <Text key={`t${i}`} color={run.color} bold={run.bold}>{run.text}</Text>
                ) : (
                  <Text key={`t${i}`}>{run.text}</Text>
                ),
              )
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
