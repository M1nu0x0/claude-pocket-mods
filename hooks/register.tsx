import type { EngineInterface, Register } from 'claude-code'

import { BELOW } from './physics'
import { encodeSprite, parseArg } from './scene'
import type { PetSprite } from './scene'

const PLUGIN = 'pocketmods'
const USAGE = 'Usage: /pocket <number> [shiny]: a national dex number (1-1025), or a form from 10001 on'

let pet: PetSprite | undefined
let petShiny = false
// The last pet /pocket asked for: a slower download of an earlier one does not replace it.
let latest: string | undefined
// What the Client last reported: a new instance (a reload, a switch of session, a dialog that hid
// the cell) picks up from here.
let resume: unknown

async function loadPet($: EngineInterface, id: number, shiny: boolean): Promise<PetSprite> {
  const key = `pet4:${id}${shiny ? ':shiny' : ''}`
  const cached = (await $.store.get(key)) as PetSprite | undefined
  if (cached !== undefined) {
    return cached
  }
  const { exitCode, stdout, stderr } = await $.process.run(
    ['/usr/bin/python3', '-I', `${$.plugin.root}/hooks/sprite.py`, String(id), ...(shiny ? ['shiny'] : [])],
    { timeoutMs: 60_000 },
  )
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `sprite.py exited ${exitCode}`)
  }
  const loaded = encodeSprite(id, JSON.parse(stdout))
  if (loaded === undefined) {
    throw new Error(`#${id} is too large or detailed to draw`)
  }
  await $.store.set(key, loaded)

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
    await $.command.register({
      name: 'pocket',
      description: 'Pick the pet by national dex number (1-1025, or a form from 10001 on); add shiny for its shiny colors',
      argumentHint: '<number 1-1025> [shiny]',
    })
    resume = await $.store.get('pet-state')
    const id = Number((await $.store.get('id')) ?? 25)
    const shiny = (await $.store.get('shiny')) === true
    loadPet($, id, shiny)
      .then(loaded => {
        if (pet === undefined) {
          pet = loaded
          petShiny = shiny
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
    const asked = parseArg(e.args)
    if (asked === undefined) {
      return { text: USAGE }
    }
    const { id, shiny } = asked
    const name = `#${id}${shiny ? ' shiny' : ''}`
    latest = name
    let loaded: PetSprite
    try {
      loaded = await loadPet($, id, shiny)
    } catch (err) {
      return { text: `pocket: ${String(err)}` }
    }
    if (latest !== name) {
      return { text: `pocket: ${name} skipped, ${latest} was asked for since` }
    }
    pet = loaded
    petShiny = shiny
    await $.store.set('id', id)
    await $.store.set('shiny', shiny)
    $.ui.invalidate('ui.render')

    return { text: `pocket: ${name}` }
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
          {/* Keyed by pet: a Client that failed is given up on, and a new pet must not inherit that. */}
          <Client key={`pet-${pet.id}${petShiny ? '-shiny' : ''}`} module="./pet-client.tsx" props={props} width="100%" height="100%" />
        </Box>
      </Box>
    )
  })
}
