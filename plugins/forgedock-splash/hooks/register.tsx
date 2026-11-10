import type { Register } from 'claude-code'
import { DURATION_MS, fits, frame, runs, themeOf } from './scene.mjs'

// One splash per process: it plays on a fresh interactive launch, never on
// /clear, resume or compact, and ends early when a prompt is submitted.
const TICK_MS = 80

const splash: { startedAt: number | null; timer: any } = {
  startedAt: null,
  timer: undefined,
}

// $ may only be handed to functions declared at the top of this file.
function end($: any) {
  splash.startedAt = null
  if (typeof splash.timer === 'function') splash.timer()
  else splash.timer?.cancel?.()
  splash.timer = undefined
  void $.ui.invalidate()
}

export const register: Register = on => {
  on('session.start', async ($, e: any, next) => {
    const isFresh =
      (e.source === undefined || e.source === 'startup') &&
      !e.isResume &&
      !e.resumed
    if (isFresh && e.isInteractive !== false && splash.startedAt === null) {
      splash.startedAt = await $.clock.now()
      splash.timer = await $.clock.every(TICK_MS, async () => {
        if (splash.startedAt === null) return
        if ((await $.clock.now()) - splash.startedAt >= DURATION_MS) end($)
        else void $.ui.invalidate()
      })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (splash.startedAt !== null) end($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e: any, next) => {
    if (splash.startedAt === null) return next(e)
    const viewport = e.viewport ?? {}
    const columns = viewport.columns ?? viewport.cols ?? e.props?.bodyColumns
    if (!fits(columns, viewport.rows)) return next(e)
    const ms = (await $.clock.now()) - splash.startedAt
    if (ms >= DURATION_MS) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rows = frame(ms, themeOf(e.props?.theme ?? e.theme)).cells.map(runs)
    return (
      <Box flexDirection="column">
        {rows.map((row, r) => (
          <Text key={`row-${r}`}>
            {row.map((run, i) => (
              <Text key={`run-${i}`} color={run.rgb ?? undefined}>
                {run.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })
}
