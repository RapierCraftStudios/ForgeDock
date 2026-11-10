import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'forgedock-splash',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: { hasSurvey: false },
  viewport: { columns: 80, rows: 12 },
} as const

// Nothing sits beneath the plugin: each hook here stands for the engine.
async function launch($: any, on: any, start: object, columns = 80) {
  let reads = 0
  // The first read is the launch (t=0); every later one is 5.5 s in.
  on('clock.now', () => ({ value: reads++ === 0 ? 0 : 5500 }))
  on('clock.every', () => ({ value: 1 }))
  on('ui.invalidate', () => ({ value: true }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: any, e: any) => e)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true, ...start })
  return { ...BAND, viewport: { columns, rows: 12 } }
}

const WORDMARK = { type: 'Text', text: /F O R G E D O C K/ } as const
const ENGINE = { type: 'Text', text: /^engine$/ } as const

test('a fresh interactive launch draws the splash above the prompt', async ($, on) => {
  const ui = await $.ui.mount((await launch($, on, {})) as any)
  expect(await ui.find(WORDMARK)).toBeTruthy()
  await ui.unmount()
})

test('a band narrower than 56 columns is left to the engine', async ($, on) => {
  const ui = await $.ui.mount((await launch($, on, {}, 40)) as any)
  expect((await ui.find(ENGINE))?.text).toBe('engine')
  await ui.unmount()
})

test('-p and SDK runs draw nothing', async ($, on) => {
  const ui = await $.ui.mount((await launch($, on, { isInteractive: false })) as any)
  expect((await ui.find(ENGINE))?.text).toBe('engine')
  await ui.unmount()
})

test('a /clear or resumed session does not play it', async ($, on) => {
  const ui = await $.ui.mount((await launch($, on, { source: 'clear' })) as any)
  expect((await ui.find(ENGINE))?.text).toBe('engine')
  await ui.unmount()
})
