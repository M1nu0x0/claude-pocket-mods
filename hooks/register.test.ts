import { expect, test } from 'claude-code/testing'

const SPRITE = { w: 1, h: 1, loop: 1, frames: [['ff0000']] }

test('a shiny pet is fetched and cached apart from the normal one', async ($, on) => {
  const fetched: string[][] = []
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    fetched.push(e.argv.slice(3))

    return { value: { exitCode: 0, stdout: JSON.stringify(SPRITE), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.invalidate', () => ({ value: undefined }))

  for (const args of ['25', '25 shiny', '25']) {
    await $.command.run({ command: 'pocket', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  }

  expect(fetched).toEqual([['25'], ['25', 'shiny']])
  expect([...stored.keys()].filter(key => key.startsWith('pet4:'))).toEqual(['pet4:25', 'pet4:25:shiny'])
  expect(stored.get('shiny')).toBe(false)
})
