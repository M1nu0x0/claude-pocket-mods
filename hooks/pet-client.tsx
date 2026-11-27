import type { ClientModule, JsonValue, RenderElement } from 'claude-code'

import { BELOW, point, resumed, start, step, TICK_MS, toAnchor, toRegion, worldOf } from './physics'
import type { Mode, Pet, Size } from './physics'
import { rectsOf } from './scene'
import type { PetSprite } from './scene'

// One sprite pixel is one CSS pixel: Desktop's rows are 16 pixels (shape heights it reports are
// whole pixels at 16 a row) and a column is half a row (a sixth of a column drew 4:3 wide).
export const PY = 1 / 16
export const PX = PY * 2
// Each box reaches a whole sprite pixel into the next one drawn, so rounding to screen pixels leaves no seam.
const BLEED = 1

// resume: the state the hooks module last kept for this pet, from a previous instance.
type Props = { sprite: PetSprite; resume?: JsonValue }

const SAVE_MS = 1000

// State null: a new pet, placed on the first tick, since before the first layout the region has no size.
const PetClient: ClientModule<Props, Pet | null> = (props, surface) => {
  const { Box } = surface.elements
  const { sprite } = props
  const px = PX * sprite.scale
  const py = PY * sprite.scale
  const size = (): Size => ({ w: sprite.w * px, h: sprite.h * py })
  const world = () => worldOf(surface.beneath, surface.columns, surface.rows)

  if (surface.state === undefined) {
    let savedAt = 0
    let savedMode: Mode | undefined
    const save = (pet: Pet) => {
      const at = Date.now()
      if (pet.mode !== savedMode || at - savedAt >= SAVE_MS) {
        savedAt = at
        savedMode = pet.mode
        const { grip: _, ...kept } = pet
        surface.post({ pet: kept })
      }
    }
    surface.every(TICK_MS, () => {
      const now = surface.state
      if (now === undefined || !surface.isWindowFocused || surface.isMotionReduced || surface.columns === 0) {
        return
      }
      const here = now === null ? start(world(), size()) : toRegion(now, surface.columns, surface.rows)
      const next = toAnchor(step(here, world(), size(), TICK_MS / 1000, Math.random), surface.columns, surface.rows)
      surface.setState(next)
      save(next)
    })
    surface.onPointer(e => {
      const now = surface.state
      if (now) {
        surface.setState(toAnchor(point(toRegion(now, surface.columns, surface.rows), e, world(), size(), Date.now()), surface.columns, surface.rows))
      }
    })
    surface.setState(resumed(props.resume) ?? null)

    return Box({})
  }

  const pet = surface.state
  if (pet === null) {
    return Box({})
  }
  // Drawn from the anchor point itself, which the layout places: surface.columns can trail a resize by a
  // frame, and a position worked out from it would shake by half of each frame's change in width.
  const frameOf = <T,>(frames: T[]): T | undefined => frames[Math.floor((pet.anim / sprite.loop) * frames.length) % frames.length]
  const mirrored = pet.face > 0
  const rects = frameOf(rectsOf(sprite)) ?? []
  const bob = pet.mode === 'walk' ? -Math.abs(Math.sin(pet.walked * 1.5)) * 0.15 : 0
  // Move on the sprite's own pixel grid, as pixel art does, so every edge lands the same way each frame.
  const left = Math.round((pet.x - (sprite.w * px) / 2) / px) * px
  const top = Math.round((pet.y - sprite.h * py + bob) / py) * py
  const pixels: RenderElement[] = rects.map(([x, y, w, h, c]) =>
    Box({
      position: 'absolute',
      // Sprites face left as drawn. Rectangles come left to right, so mirrored the bleed reaches left.
      left: left + (mirrored ? sprite.w - x - w - BLEED : x) * px,
      top: top + y * py,
      width: (w + BLEED) * px,
      height: (h + BLEED) * py,
      backgroundColor: sprite.palette[c],
    }),
  )

  const anchor = Box({ position: 'relative', width: 0, height: 0, children: pixels })

  return Box({
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-end',
    children: [anchor, Box({ width: 0, height: BELOW })],
  })
}

export default PetClient
