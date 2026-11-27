import type { Beneath, ClientPointerEvent } from 'claude-code'

// Region cells: x is the pet's middle, y its feet, rows counted down from the top.
// oneWay: a conversation box, which a thrown pet passes through from below and the sides and lands on from above.
export type Solid = { x0: number; x1: number; y0: number; y1: number; oneWay?: true }
export type World = { columns: number; rows: number; solids: readonly Solid[] }
export type Size = { w: number; h: number }

export type Mode = 'idle' | 'walk' | 'air' | 'held' | 'thrown'
export type Pet = {
  x: number
  y: number
  // Read only while thrown; a jump steers for the goal instead.
  vx: number
  vy: number
  face: 1 | -1
  mode: Mode
  wait: number
  // Kept by the surface's top so the goal follows it as the conversation scrolls.
  goal: { x: number; top: number }
  anim: number
  walked: number
  // trail: where the drag held the pet over the last TRAIL_MS, t in epoch milliseconds; letting go throws at its speed.
  grip?: { dx: number; dy: number; trail: { t: number; x: number; y: number }[] }
  // By left edge and width: the surface is found again however far it scrolls.
  on?: { x0: number; x1: number }
}

export const TICK_MS = 66
const WALK = 6
const GRAVITY = 70
const MAX_JUMP = 8
// A jump clears the top it aims for by this much, and the pet moves faster sideways in the air:
// enough time above a wall's top to carry its middle over the edge.
const CLEARANCE = 3
const AIR = WALK * 1.6
// A surface whose top is within this of the feet counts as the one stood on; a platform that rose
// up to STEP into the pet's body lifts it on top, as one that scrolls under it carries it.
const SNAP = 0.6
const STEP = 1
const WALK_ANIMATION = 1.5
// The throw's speed is the drag's over its last TRAIL_MS, as Android's VelocityTracker reads a fling, and none
// when the pointer stood still for STILL_MS before letting go. Speeds are in rows a second, a column counting
// half a row as it is drawn: slower than THROW is a drop, faster than MAX_THROW is cut down to it.
const TRAIL_MS = 100
const STILL_MS = 40
const THROW = 4
const MAX_THROW = 30
// Restitution: the share of speed into a wall, roof or floor that comes back out of it. A floor bounce slower
// than MIN_BOUNCE does not bounce at all, as Box2D's velocity threshold, and each floor bounce keeps GRIP of
// the speed along the floor.
const WALL = 0.35
const ROOF = 0.1
const FLOOR = 0.3
const MIN_BOUNCE = 6
const GRIP = 0.6
// A thrown pet moves at most this many cells a substep, so a fast throw cannot pass through a wall.
const SUBSTEP = 0.25
const EPS = 1e-6

// Solid: what a float may not paint over, and conversation boxes two rows tall or more (text lines are air).
// A wide interface shape (the band, the prompt box) is solid all the way down so nothing slips between them.
export function worldOf(beneath: readonly Beneath[], columns: number, rows: number): World {
  const isWide = (b: Beneath) => b.kind === 'interface' && b.y >= 1 && b.columns >= columns * 0.2
  const solids = beneath
    .filter(b => b.kind === 'interface' || b.rows >= 2)
    .map((b): Solid => ({
      x0: b.x,
      x1: b.x + b.columns,
      y0: b.y,
      y1: isWide(b) ? Infinity : b.y + b.rows,
      ...(b.kind === 'interface' ? {} : { oneWay: true as const }),
    }))

  // The region reaches below the window; the gutter's floor is the bottom of the prompt box.
  const wide = beneath.filter(isWide)
  const bottom = wide.length === 0 ? rows : Math.min(rows, Math.max(...wide.map(b => b.y + b.rows)))

  return { columns, rows, solids: [{ x0: 0, x1: columns, y0: bottom, y1: Infinity }, ...solids] }
}

const over = (x: number, s: Solid) => x >= s.x0 && x <= s.x1
const wideEnough = (s: Solid, size: Size) => s.x1 - s.x0 >= size.w

export const floorAt = (world: World, x: number) =>
  Math.min(...world.solids.filter(s => s.y1 === Infinity && over(x, s)).map(s => s.y0), world.rows)

const standable = (s: Solid, world: World, size: Size) => wideEnough(s, size) && s.y0 - size.h >= 0 && s.y0 <= world.rows

function footing(x: number, y: number, world: World, size: Size): Solid | undefined {
  return world.solids
    .filter(s => over(x, s) && wideEnough(s, size) && s.y0 >= y - Math.min(STEP, size.h) && s.y0 <= y + SNAP)
    .sort((a, b) => a.y0 - b.y0)[0]
}

// The range the middle may take at feet height y, between solids too tall to step onto.
function room(x: number, y: number, world: World, size: Size): { lo: number; hi: number; left?: Solid; right?: Solid } {
  let lo = size.w / 2
  let hi = world.columns - size.w / 2
  let left: Solid | undefined
  let right: Solid | undefined
  for (const s of world.solids) {
    if (s.y0 < y - STEP && s.y1 > y - size.h) {
      if (s.x1 <= x && s.x1 + size.w / 2 > lo) {
        lo = s.x1 + size.w / 2
        left = s
      } else if (s.x0 >= x && s.x0 - size.w / 2 < hi) {
        hi = s.x0 - size.w / 2
        right = s
      }
    }
  }

  return { lo, hi: Math.max(hi, lo), left, right }
}

const toward = (from: number, to: number, most: number) => from + Math.sign(to - from) * Math.min(most, Math.abs(to - from))
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export const start = (world: World, size: Size): Pet => ({
  x: world.columns / 2,
  y: size.h,
  vx: 0,
  vy: 0,
  face: -1,
  mode: 'air',
  wait: 1,
  goal: { x: world.columns / 2, top: floorAt(world, world.columns / 2) },
  anim: 0,
  walked: 0,
})

function pickGoal(pet: Pet, world: World, size: Size, rand: () => number): Pet['goal'] {
  const here = footing(pet.x, pet.y, world, size)
  const reachable = world.solids.filter(s => standable(s, world, size) && pet.y - s.y0 <= MAX_JUMP)
  const surface = rand() < 0.4 && here ? here : (reachable[Math.floor(rand() * reachable.length)] ?? here)
  if (surface === undefined) {
    return pet.goal
  }
  const span = room(clamp(pet.x, surface.x0, surface.x1), surface.y0, world, size)
  const lo = Math.max(surface.x0 + size.w / 2, span.lo)
  const hi = Math.min(surface.x1 - size.w / 2, span.hi)

  return { x: lo + rand() * Math.max(hi - lo, 0), top: surface.y0 }
}

const jump = (pet: Pet, top: number): Pet => ({
  ...pet,
  mode: 'air',
  // One tick of gravity more: stepping in ticks tops out lower than the formula says.
  vy: -(Math.sqrt(2 * GRAVITY * Math.max(pet.y - top + CLEARANCE, CLEARANCE)) + GRAVITY * (TICK_MS / 1000)),
})

const rest = (pet: Pet, seconds: number): Pet => ({ ...pet, mode: 'idle', wait: seconds })

// The pet's speed over the trail, measured where the drag held it, so a pet pinned on a wall is not thrown into it.
function release(trail: { t: number; x: number; y: number }[], now: number): { vx: number; vy: number } {
  const recent = trail.filter(p => now - p.t <= TRAIL_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (first === undefined || last === undefined || now - last.t > STILL_MS || last.t - first.t < 8) {
    return { vx: 0, vy: 0 }
  }
  const seconds = (last.t - first.t) / 1000
  const vx = (last.x - first.x) / seconds
  const vy = (last.y - first.y) / seconds
  const speed = Math.hypot(vx / 2, vy)
  if (speed < THROW) {
    return { vx: 0, vy: 0 }
  }
  // Scaled as a whole, so a capped throw keeps its direction.
  const scale = Math.min(1, MAX_THROW / speed)

  return { vx: vx * scale, vy: vy * scale }
}

export function point(pet: Pet, e: Pick<ClientPointerEvent, 'type' | 'x' | 'y' | 'fine' | 'button'>, world: World, size: Size, now: number): Pet {
  const px = e.fine?.x ?? e.x + 0.5
  const py = e.fine?.y ?? e.y + 0.5
  if (e.type === 'down' && e.button === 'left') {
    const onPet = Math.abs(px - pet.x) <= size.w / 2 && py <= pet.y && py >= pet.y - size.h
    return onPet ? { ...pet, mode: 'held', vx: 0, vy: 0, grip: { dx: pet.x - px, dy: pet.y - py, trail: [{ t: now, x: pet.x, y: pet.y }] } } : pet
  }
  if (pet.mode !== 'held' || pet.grip === undefined) {
    return pet
  }
  const grip = pet.grip
  if (e.type === 'move' && e.button !== undefined) {
    const span = room(pet.x, pet.y, world, size)
    const x = clamp(px + grip.dx, span.lo, span.hi)
    const y = clamp(py + grip.dy, size.h, floorAt(world, x))
    const trail = [...grip.trail.filter(p => now - p.t <= TRAIL_MS), { t: now, x, y }]
    return { ...pet, x, y, grip: { ...grip, trail }, face: Math.abs(x - pet.x) > 0.01 ? (x > pet.x ? 1 : -1) : pet.face }
  }
  // A move with no button down while held is a hover: the button came up where no `up` reached the region.
  if (e.type === 'up' || e.type === 'move') {
    const v = release(grip.trail, now)
    const thrown = v.vx !== 0 || v.vy !== 0
    return { ...pet, ...v, mode: thrown ? 'thrown' : 'air', grip: undefined, goal: { x: pet.x, top: floorAt(world, pet.x) } }
  }

  return pet
}

function onGround(pet: Pet, world: World, size: Size, dt: number, rand: () => number): Pet {
  const on = pet.on
  const kept = on && world.solids
    .filter(s => Math.abs(s.x0 - on.x0) < 0.5 && Math.abs(s.x1 - on.x1) < 0.5 && over(pet.x, s))
    .sort((a, b) => Math.abs(a.y0 - pet.y) - Math.abs(b.y0 - pet.y))[0]
  const near = footing(pet.x, pet.y, world, size)
  const under = near !== undefined && (kept === undefined || near.y0 < kept.y0) ? near : (kept ?? near)
  if (under === undefined) {
    return { ...pet, mode: 'air', vy: 0, on: undefined }
  }
  let next: Pet = { ...pet, y: under.y0, on: { x0: under.x0, x1: under.x1 } }
  // Carried up into the ceiling: drop through the surface to whatever is below.
  if (under.y0 - size.h < 0 && under.y1 !== Infinity) {
    return { ...next, y: under.y0 + 0.05, mode: 'air', vy: 0, goal: { x: next.x, top: floorAt(world, next.x) } }
  }

  if (next.mode === 'idle') {
    next.wait -= dt
    return next.wait > 0 ? next : { ...next, mode: 'walk', goal: pickGoal(next, world, size, rand) }
  }

  const target = world.solids
    .filter(s => over(next.goal.x, s) && standable(s, world, size))
    .sort((a, b) => Math.abs(a.y0 - next.goal.top) - Math.abs(b.y0 - next.goal.top))[0]
  if (target === undefined || Math.abs(target.y0 - next.goal.top) > 3) {
    return rest(next, 1)
  }
  next.goal = { x: next.goal.x, top: target.y0 }

  const sameLevel = Math.abs(target.y0 - next.y) < SNAP
  // Higher: get under it first, then jump. Same or lower: head for the goal (off an edge, if lower).
  const aim = !sameLevel && target.y0 < next.y ? clamp(next.x, target.x0 + size.w / 2, target.x1 - size.w / 2) : next.goal.x
  if (!sameLevel && target.y0 < next.y && Math.abs(aim - next.x) < 0.3) {
    return jump(next, target.y0)
  }
  if (sameLevel && Math.abs(next.x - next.goal.x) < 0.05) {
    return rest(next, 2 + rand() * 4)
  }

  const span = room(next.x, next.y, world, size)
  const wanted = toward(next.x, aim, WALK * dt)
  if (wanted >= span.lo && wanted <= span.hi) {
    return { ...next, x: wanted }
  }
  const wall = wanted < span.lo ? span.left : span.right
  next.x = clamp(wanted, span.lo, span.hi)
  if (wall !== undefined && standable(wall, world, size) && next.y - wall.y0 <= MAX_JUMP) {
    return { ...jump(next, wall.y0), goal: { x: clamp(next.goal.x, wall.x0 + size.w / 2, wall.x1 - size.w / 2), top: wall.y0 } }
  }
  const [lo, hi] = wanted < span.lo ? ([next.x, span.hi] as const) : ([span.lo, next.x] as const)

  return { ...next, goal: { x: lo + rand() * (hi - lo), top: next.y } }
}

function inAir(pet: Pet, world: World, size: Size, dt: number): Pet {
  const before = pet.y
  let vy = pet.vy + GRAVITY * dt
  let y = pet.y + vy * dt
  if (y - size.h < 0) {
    y = size.h
    vy = Math.max(vy, 0)
  }
  const span = room(pet.x, Math.min(y, before), world, size)
  const x = clamp(toward(pet.x, pet.goal.x, AIR * dt), span.lo, span.hi)
  if (vy > 0) {
    // One-way tops: land on the first one crossed on the way down.
    const landing = world.solids
      .filter(s => s.y0 >= before - 0.01 && s.y0 <= y && over(x, s) && wideEnough(s, size))
      .sort((a, b) => a.y0 - b.y0)[0]
    if (landing !== undefined) {
      const landed = { ...pet, x, y: landing.y0, vy: 0, on: { x0: landing.x0, x1: landing.x1 } }
      return Math.abs(landing.y0 - pet.goal.top) < SNAP && Math.abs(x - pet.goal.x) < 0.3
        ? { ...landed, mode: 'idle', wait: 2 }
        : { ...landed, mode: 'walk' }
    }
  }

  const floor = floorAt(world, x)
  return { ...pet, x, y: Math.min(y, floor), vy, mode: y >= floor ? 'walk' : 'air' }
}

// Thrown: each substep moves across, then up or down, and a contact turns back only the speed into it
// (x off a wall, y off a roof or floor), so hitting the roof never sends the pet back the way it came.
function flight(pet: Pet, world: World, size: Size, dt: number): Pet {
  let { x, y, vx, vy } = pet
  const half = size.w / 2
  const n = Math.max(1, Math.ceil((Math.max(Math.abs(vx), Math.abs(vy)) + GRAVITY * dt) * dt / SUBSTEP))
  const h = dt / n
  for (let i = 0; i < n; i++) {
    vy += GRAVITY * h

    const beside = (s: Solid) => !s.oneWay && s.y0 < y - EPS && s.y1 > y - size.h + EPS
    const nx = x + vx * h
    if (vx > 0) {
      const wall = Math.min(world.columns, ...world.solids.filter(s => beside(s) && s.x0 >= x + half - EPS).map(s => s.x0))
      x = nx + half > wall ? wall - half : nx
      vx = nx + half > wall ? -vx * WALL : vx
    } else if (vx < 0) {
      const wall = Math.max(0, ...world.solids.filter(s => beside(s) && s.x1 <= x - half + EPS).map(s => s.x1))
      x = nx - half < wall ? wall + half : nx
      vx = nx - half < wall ? -vx * WALL : vx
    }

    const ny = y + vy * h
    if (vy < 0) {
      const above = (s: Solid) => !s.oneWay && s.x0 < x + half - EPS && s.x1 > x - half + EPS && s.y1 <= y - size.h + EPS
      const roof = Math.max(0, ...world.solids.filter(above).map(s => s.y1))
      y = ny - size.h < roof ? roof + size.h : ny
      vy = ny - size.h < roof ? -vy * ROOF : vy
      continue
    }
    const ground = world.solids
      .filter(s => s.y0 >= y - EPS && s.y0 <= ny && over(x, s) && wideEnough(s, size))
      .sort((a, b) => a.y0 - b.y0)[0]
    if (ground === undefined) {
      y = Math.min(ny, floorAt(world, x))
      continue
    }
    y = ground.y0
    if (vy * FLOOR < MIN_BOUNCE) {
      return { ...pet, x, y, vx: 0, vy: 0, mode: 'idle', wait: 1, on: { x0: ground.x0, x1: ground.x1 }, goal: { x, top: y } }
    }
    vy = -vy * FLOOR
    vx *= GRIP
  }

  return { ...pet, x, y, vx, vy }
}

// register.tsx floats the region from the prompt's cell, floatColumns to each side and BELOW rows under it,
// so in the region's cells that cell is always at the middle column, BELOW rows from the bottom. The pet's
// state is kept measured from it, and so stays where it is on screen as the region resizes around the cell.
export const BELOW = 12
const anchorOf = (columns: number, rows: number) => ({ x: columns / 2, y: rows - BELOW })

const shift = (pet: Pet, dx: number, dy: number): Pet => ({
  ...pet,
  x: pet.x + dx,
  y: pet.y + dy,
  goal: { x: pet.goal.x + dx, top: pet.goal.top + dy },
  on: pet.on && { x0: pet.on.x0 + dx, x1: pet.on.x1 + dx },
  grip: pet.grip && { ...pet.grip, trail: pet.grip.trail.map(p => ({ ...p, x: p.x + dx, y: p.y + dy })) },
})

export function toRegion(pet: Pet, columns: number, rows: number): Pet {
  const a = anchorOf(columns, rows)
  return shift(pet, a.x, a.y)
}

export function toAnchor(pet: Pet, columns: number, rows: number): Pet {
  const a = anchorOf(columns, rows)
  return shift(pet, -a.x, -a.y)
}

export function step(pet: Pet, world: World, size: Size, dt: number, rand: () => number): Pet {
  const now = { ...pet, anim: pet.anim + dt * (pet.mode === 'walk' ? WALK_ANIMATION : 1) }
  if (now.mode === 'held') {
    return now
  }

  // The region shrank past the pet: bring it back inside and let it fall.
  const inside = clamp(now.x, size.w / 2, Math.max(world.columns - size.w / 2, size.w / 2))
  if (inside !== now.x || now.y > world.rows) {
    return { ...now, x: inside, y: now.y > world.rows ? size.h : now.y, vx: 0, vy: 0, mode: 'air', on: undefined, goal: { x: inside, top: floorAt(world, inside) } }
  }

  // The edge of the reach closed over the pet: move it sideways to the nearest free spot and let it fall.
  const buried = (x: number, y: number) => world.solids.some(s => s.x0 < x && x < s.x1 && s.y0 < y - STEP && s.y1 > y - size.h && s.y1 !== Infinity && s.y0 <= 0)
  if (buried(now.x, now.y)) {
    const free = Array.from({ length: Math.ceil(world.columns) }, (_, d) => [now.x - d, now.x + d])
      .flat()
      .find(at => at >= size.w / 2 && at <= world.columns - size.w / 2 && !buried(at, now.y))
    const x = free ?? world.columns / 2
    return { ...now, x, vx: 0, vy: 0, mode: 'air', on: undefined, goal: { x, top: floorAt(world, x) } }
  }
  // The floor rose over the feet (the band grew): stand on it.
  const floor = floorAt(world, now.x)
  if (now.y > floor + SNAP) {
    return { ...now, y: floor, vx: 0, vy: 0, mode: now.mode === 'air' || now.mode === 'thrown' ? 'walk' : now.mode }
  }

  const next = now.mode === 'thrown'
    ? flight(now, world, size, dt)
    : now.mode === 'air'
      ? inAir(now, world, size, dt)
      : onGround(now, world, size, dt, rand)
  if (Math.abs(next.x - pet.x) > 0.001) {
    next.face = next.x > pet.x ? 1 : -1
    next.walked += Math.abs(next.x - pet.x)
  }

  return next
}

export function resumed(kept: unknown): Pet | undefined {
  const pet = kept as Partial<Pet> | null | undefined
  const numbers = [pet?.x, pet?.y, pet?.vy, pet?.wait, pet?.anim, pet?.walked]
  if (pet == null || pet.goal === undefined || pet.mode === undefined || !numbers.every(n => typeof n === 'number')) {
    return undefined
  }
  // Kept before throws existed: no vx.
  const whole = { ...(pet as Pet), vx: typeof pet.vx === 'number' ? pet.vx : 0 }

  return whole.mode === 'held' ? { ...whole, mode: 'air' } : whole
}
