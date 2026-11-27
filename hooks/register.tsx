import type { EngineInterface, Register } from 'claude-code'

import { BELOW } from './physics'
import { encodeSprite, parseArg } from './scene'
import type { PetSprite } from './scene'

const PLUGIN = 'pocketmods'
const USAGE = 'Usage: /pocket <number>: a national dex number (1-1025), or a form from 10001 on'

let pet: PetSprite | undefined
// The last number /pocket asked for: a slower download of an earlier one does not replace it.
let latest: number | undefined
// What the Client last reported: a new instance (a reload, a switch of session, a dialog that hid
// the cell) picks up from here.
let resume: unknown

async function loadPet($: EngineInterface, id: number): Promise<PetSprite> {
  const cached = (await $.store.get(`pet4:${id}`)) as PetSprite | undefined
  if (cached !== undefined) {
    return cached
  }
  const { exitCode, stdout, stderr } = await $.process.run(
    ['/usr/bin/python3', '-I', `${$.plugin.root}/hooks/sprite.py`, String(id)],
    { timeoutMs: 60_000 },
  )
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `sprite.py exited ${exitCode}`)
  }
  const loaded = encodeSprite(id, JSON.parse(stdout))
  if (loaded === undefined) {
    throw new Error(`#${id} is too large or detailed to draw`)
  }
  await $.store.set(`pet4:${id}`, loaded)

  return loaded
}

export const register: Register = on => {
  on('ui.message', async ($, e, next) => {
    const state = (e.data as { pet?: unknown } | null)?.pet
    if (state !== undefined) {
      // Through JSON, so no undefined field reaches the Client's props, which refuse one.
      resume = JSON.parse(JSON.stringify(state))
      await $.store.set('pet-state', resume)
    }

    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pocket', description: 'Pick the pet by national dex number, or a form from 10001 on', argumentHint: '<number>' })
    resume = await $.store.get('pet-state')
    const id = Number((await $.store.get('id')) ?? 25)
    loadPet($, id)
      .then(loaded => {
        if (pet === undefined) {
          pet = loaded
          $.ui.invalidate('ui.render')
        }
      })
      .catch(err => $.ui.toast(`pocket: ${String(err)}`))

    return next(e)
  })

  // The menu is listed per session, not per surface, and cached until invalidated.
  on('command.describe', { command: 'pocket' }, async ($, e, next) =>
    next({ ...e, isHidden: !(await $.session.surfaces()).includes('desktop') }),
  )
  on('session.attach', ($, e, next) => {
    $.ui.invalidate('command.describe')

    return next(e)
  })
  on('session.detach', ($, e, next) => {
    $.ui.invalidate('command.describe')

    return next(e)
  })

  on('command.run', { command: 'pocket' }, async ($, e) => {
    const id = parseArg(e.args)
    if (id === undefined) {
      return { text: USAGE }
    }
    latest = id
    let loaded: PetSprite
    try {
      loaded = await loadPet($, id)
    } catch (err) {
      return { text: `pocket: ${String(err)}` }
    }
    if (latest !== id) {
      return { text: `pocket: #${id} skipped, #${latest} was asked for since` }
    }
    pet = loaded
    await $.store.set('id', id)
    $.ui.invalidate('ui.render')

    return { text: `pocket: #${id}` }
  })

  // Past the reach and under what a float may not paint over, the Client hears interface shapes as walls and floors.
  on('ui.render', { component: 'BesidePrompt' }, ($, e, next) => {
    if (e.surface !== 'desktop' || e.plugin !== PLUGIN || pet === undefined || e.props.floatRows < 1) {
      return next(e)
    }
    const { Box, Client } = $.ui.resolve(e)
    const props = { sprite: pet, ...(resume === undefined ? {} : { resume }) }

    return (
      <Box width={0}>
        <Box
          position="absolute"
          anchor="above"
          bottom={-BELOW}
          right={-e.props.floatColumns}
          width={e.props.floatColumns * 2}
          height={e.props.floatRows + BELOW}
        >
          {/* Keyed by number: a Client that failed is given up on, and a new pet must not inherit that. */}
          <Client key={`pet-${pet.id}`} module="./pet-client.tsx" props={props} width="100%" height="100%" />
        </Box>
      </Box>
    )
  })
}
