import { expect, test } from 'claude-code/testing'

import { floorAt, point, resumed, start, step, toAnchor, toRegion, worldOf } from './physics'
import type { Pet, World } from './physics'
import { encodeSprite, MAX_RECTS, parseArg, PROPS_LIMIT } from './scene'

type Shape = { x: number; y: number; columns: number; rows: number; kind: 'interface' | 'conversation' }

const size = { w: 10, h: 5 }
const band: Shape = { x: 0, y: 35, columns: 100, rows: 3, kind: 'interface' }
const world = (...shapes: Shape[]) => worldOf([band, ...shapes], 100, 50)
const run = (pet: Pet, w: World | ((tick: number) => World), seconds: number, rand = () => 0.99) => {
  let now = pet
  for (let i = 0; i < seconds / 0.066; i++) {
    now = step(now, typeof w === 'function' ? w(i) : w, size, 0.066, rand)
  }
  return now
}
const standing = (w: World, x: number, y: number, mode: Pet['mode'] = 'idle'): Pet => ({ ...start(w, size), x, y, mode, wait: 10 })

test('runs of one color become one run and share a palette entry', async () => {
  const sprite = { w: 4, h: 2, loop: 1, frames: [['ff0000ff0000......00ff00', '......ff0000............']] }

  const pet = encodeSprite(7, sprite)

  expect(pet?.palette).toEqual(['#ff0000', '#00ff00'])
  expect(pet?.frames).toEqual(['0000020100' + '0300010101' + '0101010100'])
})

test('vertical repeats of a run become one rectangle', async () => {
  const pet = encodeSprite(1, { w: 2, h: 3, loop: 1, frames: [['ff0000ff0000', 'ff0000ff0000', 'ff000000ff00']] })

  expect(pet?.frames).toEqual(['0000020200' + '0002010100' + '0102010101'])
})

const checker = (w: number, h: number, count: number) => {
  const row = (shift: number) => Array.from({ length: w }, (_, x) => (Math.floor((x + shift) / 2) % 2 ? '123456' : 'abcdef')).join('')

  return Array.from({ length: count }, () => Array.from({ length: h }, (_, y) => row(y % 2)))
}

test('frames are dropped evenly until the props fit', async () => {
  const pet = encodeSprite(1, { w: 40, h: 25, loop: 6, frames: checker(40, 25, 20) })

  expect(pet?.scale).toBe(1)
  expect(pet?.frames.length).toBeLessThan(20)
  expect(JSON.stringify({ sprite: pet }).length).toBeLessThanOrEqual(PROPS_LIMIT)
})

test('a sprite with too many boxes a frame is drawn coarser at the same size', async () => {
  const pet = encodeSprite(1, { w: 96, h: 96, loop: 6, frames: checker(96, 96, 12) })

  expect(pet?.scale).toBeGreaterThan(1)
  expect(pet?.frames.every(f => f.length / 10 <= MAX_RECTS)).toBe(true)
  expect((pet?.w ?? 0) * (pet?.scale ?? 0)).toBeGreaterThanOrEqual(96)
})

test('the band and boxes two rows tall are solid, text lines are open air', async () => {
  const w = world({ x: 50, y: 20, columns: 40, rows: 3, kind: 'conversation' }, { x: 0, y: 10, columns: 80, rows: 1, kind: 'conversation' })

  expect(floorAt(w, 50)).toBe(35)
  expect(w.solids.map(s => [s.x0, s.y0])).toEqual([[0, 38], [0, 35], [50, 20]])
})

test('a new pet drops from the top onto the band', async () => {
  const w = world()

  const settled = run(start(w, size), w, 2)

  expect(settled.y).toBe(35)
})

test('nothing under the band is open, even the gap above the prompt box', async () => {
  const w = world({ x: 0, y: 39, columns: 100, rows: 4, kind: 'interface' })
  const held = point(standing(w, 50, 35), { type: 'down', x: 50, y: 33, button: 'left' }, w, size, 0)

  const dragged = point(held, { type: 'move', x: 50, y: 37, button: 'left' }, w, size, 0)

  expect(dragged.y).toBeLessThanOrEqual(35)
})

test('a goal on a box above: walk under it, jump, land on top', async () => {
  const w = world({ x: 40, y: 28, columns: 40, rows: 3, kind: 'conversation' })
  const pet = { ...standing(w, 15, 35, 'walk'), goal: { x: 60, top: 28 } }

  const after = run(pet, w, 10)

  expect(after.y).toBe(28)
  expect(Math.abs(after.x - 60)).toBeLessThan(0.1)
})

test('a goal below: walk off the edge and fall to it', async () => {
  const w = world({ x: 40, y: 28, columns: 40, rows: 3, kind: 'conversation' })
  const pet = { ...standing(w, 60, 28, 'walk'), goal: { x: 15, top: 35 } }

  const after = run(pet, w, 10)

  expect(after.y).toBe(35)
  expect(Math.abs(after.x - 15)).toBeLessThan(0.1)
})

test('a wall too tall to climb turns the pet back', async () => {
  const w = world({ x: 60, y: 0, columns: 40, rows: 35, kind: 'interface' })
  const pet = { ...standing(w, 40, 35, 'walk'), goal: { x: 90, top: 35 } }

  const after = run(pet, w, 3)

  expect(after.x).toBeLessThanOrEqual(55)
  expect(after.goal.x).toBeLessThan(after.x + 0.01)
})

test('a wall with a top within a jump is jumped onto', async () => {
  const w = world({ x: 60, y: 30, columns: 30, rows: 5, kind: 'conversation' })
  const pet = { ...standing(w, 40, 35, 'walk'), goal: { x: 95, top: 35 } }

  const after = run(pet, w, 5)

  expect(after.y).toBe(30)
  expect(after.x).toBeGreaterThan(60)
})

test('a pet on a bubble rides it as the conversation scrolls', async () => {
  const rising = (tick: number) => world({ x: 40, y: 25 - tick * 0.3, columns: 40, rows: 3, kind: 'conversation' })
  const pet = standing(rising(0), 60, 25)

  const after = run(pet, rising, 1)

  expect(after.mode).toBe('idle')
  expect(Math.abs(after.y - (25 - 15 * 0.3))).toBeLessThan(0.35)
})

test('a pet stays on its bubble when the screen jumps it many rows at once', async () => {
  const at = (top: number) => world({ x: 40, y: top, columns: 40, rows: 3, kind: 'conversation' })
  const settled = run(standing(at(25), 60, 25), at(25), 0.2)

  const jumped = run(settled, at(14), 0.1)
  const back = run(jumped, at(22), 0.1)

  expect(jumped.y).toBe(14)
  expect(back.y).toBe(22)
  expect(back.x).toBe(settled.x)
})

test('a bubble rising up under the pet lifts it on top', async () => {
  const w = world({ x: 40, y: 34.5, columns: 40, rows: 3, kind: 'conversation' })

  const after = run(standing(w, 60, 35), w, 0.1)

  expect(after.y).toBe(34.5)
})

test('carried into the ceiling, the pet drops through the bubble to the band', async () => {
  const rising = (tick: number) => world({ x: 40, y: Math.max(8 - tick * 0.5, 1), columns: 40, rows: 3, kind: 'conversation' })
  const pet = standing(rising(0), 60, 8)

  const after = run(pet, rising, 3)

  expect(after.y).toBe(35)
})

test('pressing on the pet picks it up and dragging carries it by the same spot', async () => {
  const w = world()
  const held = point(standing(w, 50, 35), { type: 'down', x: 51, y: 33, fine: { x: 51.5, y: 33.5 }, button: 'left' }, w, size, 0)

  const dragged = point(held, { type: 'move', x: 70, y: 20, fine: { x: 70.5, y: 20.5 }, button: 'left' }, w, size, 0)

  expect(held.mode).toBe('held')
  expect(Math.abs(dragged.x - 69)).toBeLessThan(1e-9)
  expect(Math.abs(dragged.y - 22)).toBeLessThan(1e-9)
  expect(dragged.face).toBe(1)
})

test('a press beside the pet does not pick it up', async () => {
  const w = world()

  const after = point(standing(w, 50, 35), { type: 'down', x: 80, y: 33, button: 'left' }, w, size, 0)

  expect(after.mode).toBe('idle')
})

test('a held pet stays put until dropped, then falls onto the bubble below', async () => {
  const w = world({ x: 40, y: 25, columns: 40, rows: 3, kind: 'conversation' })
  const held = point(standing(w, 50, 35), { type: 'down', x: 50, y: 33, button: 'left' }, w, size, 0)
  const lifted = point(held, { type: 'move', x: 60, y: 8, button: 'left' }, w, size, 0)

  const hanging = run(lifted, w, 1)
  const dropped = run(point(hanging, { type: 'up', x: 60, y: 8, button: 'left' }, w, size, 0), w, 2)

  expect(hanging.y).toBe(lifted.y)
  expect(dropped.y).toBe(25)
  expect(dropped.grip).toBeUndefined()
})

// Picked up at 50, dragged dx, dy over 60 ms in three moves, let go 10 ms after the last.
const flung = (w: World, dx: number, dy: number, upAt = 70) => {
  let pet = point(standing(w, 50, 35), { type: 'down', x: 50, y: 33, button: 'left' }, w, size, 0)
  for (const k of [1, 2, 3]) {
    pet = point(pet, { type: 'move', x: 50 + (dx * k) / 3, y: 33 + (dy * k) / 3, button: 'left' }, w, size, k * 20)
  }
  return point(pet, { type: 'up', x: 50 + dx, y: 33 + dy, button: 'left' }, w, size, upAt)
}
const ticks = (pet: Pet, w: World, count: number) => {
  const all: Pet[] = []
  let now = pet
  for (let i = 0; i < count; i++) {
    now = step(now, w, size, 0.066, () => 0.99)
    all.push(now)
  }
  return all
}
const thrown = (x: number, y: number, vx: number, vy: number): Pet => ({ ...standing(world(), x, y), mode: 'thrown', vx, vy })

test('a fast drag let go throws the pet the way it was moving', async () => {
  const w = world()

  const pet = flung(w, 6, -6)
  const after = run(pet, w, 0.2)

  expect(pet.mode).toBe('thrown')
  expect(pet.vx).toBeGreaterThan(0)
  expect(pet.vy).toBeLessThan(0)
  expect(after.x).toBeGreaterThan(pet.x + 3)
  expect(after.y).toBeLessThan(pet.y)
})

test('a throw too fast is cut down to the cap without turning its direction', async () => {
  const w = world()

  const pet = flung(w, 30, -15)

  expect(Math.abs(Math.hypot(pet.vx / 2, pet.vy) - 30)).toBeLessThan(1e-9)
  expect(Math.abs(pet.vx / pet.vy + 2)).toBeLessThan(1e-9)
})

test('a drag that stood still before letting go is a drop, not a throw', async () => {
  const w = world()

  const pet = flung(w, 20, -10, 120)

  expect(pet.mode).toBe('air')
  expect(pet.vx).toBe(0)
  expect(pet.vy).toBe(0)
})

test('a hover move after a missed up lets go of the pet instead of dragging it along', async () => {
  const w = world()
  const held = point(standing(w, 50, 35), { type: 'down', x: 50, y: 33, button: 'left' }, w, size, 0)
  const lifted = point(held, { type: 'move', x: 50, y: 20, button: 'left' }, w, size, 10)

  const hovered = point(lifted, { type: 'move', x: 80, y: 30 }, w, size, 1000)

  expect(hovered.mode).toBe('air')
  expect(hovered.x).toBe(lifted.x)
  expect(hovered.y).toBe(lifted.y)
  expect(hovered.grip).toBeUndefined()
})

test('a hover move right after a missed up still throws', async () => {
  const w = world()
  let pet = point(standing(w, 50, 35), { type: 'down', x: 50, y: 33, button: 'left' }, w, size, 0)
  for (const k of [1, 2, 3]) {
    pet = point(pet, { type: 'move', x: 50 + 2 * k, y: 33 - 2 * k, button: 'left' }, w, size, k * 20)
  }

  const hovered = point(pet, { type: 'move', x: 57, y: 26 }, w, size, 70)

  expect(hovered.mode).toBe('thrown')
  expect(hovered.x).toBe(pet.x)
})

test('thrown into the region side, the pet comes back at a third of its speed', async () => {
  const w = world()

  const all = ticks(thrown(80, 10, 40, 0), w, 10)
  const back = all.find(p => p.vx < 0)

  expect(Math.max(...all.map(p => p.x))).toBeLessThanOrEqual(95)
  expect(back?.vx).toBeGreaterThan(-40 * 0.36)
})

test('an interface shape beside the pet is a wall it bounces off', async () => {
  const w = world({ x: 70, y: 0, columns: 30, rows: 35, kind: 'interface' })

  const all = ticks({ ...thrown(50, 30, 30, -5) }, w, 10)

  expect(Math.max(...all.map(p => p.x))).toBeLessThanOrEqual(65)
  expect(all.some(p => p.vx < 0)).toBe(true)
})

test('hitting the roof turns back only the upward speed, never the sideways one', async () => {
  const w = world()

  const all = ticks(thrown(30, 12, 10, -40), w, 12).filter(p => p.mode === 'thrown')
  const ys = all.map(p => p.y)

  expect(Math.min(...ys)).toBeGreaterThanOrEqual(size.h)
  expect(Math.min(...ys)).toBeLessThan(size.h + 1)
  expect(all.every(p => p.vx > 0)).toBe(true)
})

test('a conversation box the throw rises past is passed through, not a wall', async () => {
  const w = world({ x: 55, y: 15, columns: 20, rows: 5, kind: 'conversation' })

  const xs = ticks(thrown(45, 24, 30, -5), w, 5).map(p => p.x)

  expect(xs.every((x, i) => i === 0 || x > (xs[i - 1] ?? 0))).toBe(true)
  expect(xs[xs.length - 1]).toBeGreaterThan(50)
})

test('a thrown pet bounces low on the floor, then rests where it landed', async () => {
  const w = world()

  const all = ticks(thrown(30, 10, 10, 0), w, 60)
  const bounced = all.findIndex(p => p.vy < 0)
  const after = all[all.length - 1]

  expect(bounced).toBeGreaterThan(0)
  expect(Math.min(...all.slice(bounced).map(p => p.y))).toBeGreaterThan(35 - 3)
  expect(after?.y).toBe(35)
  expect(after?.vx).toBe(0)
  expect(after?.mode).not.toBe('thrown')
})

test('beside the band the pet goes down to the bottom of the prompt box, not hanging at the band top', async () => {
  const w = worldOf([{ ...band, columns: 70 }, { x: 0, y: 39, columns: 70, rows: 4, kind: 'interface' }], 100, 50)
  const pet = { ...standing(w, 50, 35, 'walk'), goal: { x: 90, top: 43 } }

  const after = run(pet, w, 10)

  expect(after.y).toBe(43)
  expect(Math.abs(after.x - 90)).toBeLessThan(0.1)
})

test('a pet the edge of the reach closes over after a resize drops again where it is free', async () => {
  const shrunk = world({ x: 0, y: 0, columns: 60, rows: 35, kind: 'interface' })

  const after = step(standing(world(), 30, 35), shrunk, size, 0.066, () => 0.5)

  expect(after.x).toBeGreaterThanOrEqual(60)
  expect(after.mode).toBe('air')
})

test('a pet kept from the anchor stays put on screen as the region resizes around it', async () => {
  const pet = standing(world(), 60, 35)

  const kept = toAnchor(pet, 100, 50)
  const wider = toRegion(kept, 140, 60)

  expect(kept.x).toBe(10)
  expect(kept.y).toBe(-3)
  expect(wider.x).toBe(80)
  expect(wider.y).toBe(45)
  expect(toAnchor(wider, 140, 60)).toEqual(kept)
})

test('a pet left past the region side after it shrank is brought back inside', async () => {
  const w = world()

  const after = step(standing(w, 130, 35), w, size, 0.066, () => 0.5)

  expect(after.x).toBe(95)
  expect(after.mode).toBe('air')
})

test('a pet buried by the reach moves to the nearest free column, not back to the middle', async () => {
  const shrunk = world({ x: 0, y: 0, columns: 20, rows: 35, kind: 'interface' })

  const after = step(standing(world(), 15, 35), shrunk, size, 0.066, () => 0.5)

  expect(after.x).toBeLessThan(30)
  expect(after.y).toBeGreaterThan(30)
})

test('a pet kept while held is resumed falling', async () => {
  const kept = { ...standing(world(), 50, 35), mode: 'held' }

  const pet = resumed(JSON.parse(JSON.stringify(kept)))

  expect(pet?.mode).toBe('air')
  expect(pet?.x).toBe(50)
})

test('a kept state missing fields is not resumed', async () => {
  const { anim: _, ...partial } = standing(world(), 50, 35)

  const pets = [partial, null, undefined, 'pet'].map(resumed)

  expect(pets).toEqual([undefined, undefined, undefined, undefined])
})

test('a state kept before throws existed resumes not thrown', async () => {
  const { vx: _, ...old } = standing(world(), 50, 35)

  const pet = resumed(old)

  expect(pet?.vx).toBe(0)
})

test('the command takes any positive whole number, leaving which have a sprite to the download', async () => {
  const parsed = ['25', ' 1025 ', '10001', '0', '-3', 'pikachu', '2.5', '1e400', ''].map(parseArg)

  expect(parsed).toEqual([25, 1025, 10001, undefined, undefined, undefined, undefined, undefined, undefined])
})
