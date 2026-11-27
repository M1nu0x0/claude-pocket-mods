// What sprite.py prints: rows of 6 hex chars a pixel, "......" for clear.
export type Sprite = { w: number; h: number; loop: number; frames: string[][] }
// What the Client draws: a palette and, per frame, one string of rectangles, each 10 hex digits:
// x, y, width, height and color index, two digits each, top to bottom. A Client's props hold
// 20000 values at most, so a frame is one string. scale: how many source pixels a side one pixel stands for.
export type PetSprite = { id: number; w: number; h: number; scale: number; loop: number; palette: string[]; frames: string[] }

const CLEAR = '......'
// A Client's props may hold 100000 characters; keep room for the rest.
export const PROPS_LIMIT = 90_000
// So does the tree a Client draws, about 130 characters a box: past this many a frame, the sprite is drawn coarser.
export const MAX_RECTS = 600

type Rect = { x: number; y: number; w: number; h: number; c: number }

// Runs of one color along a row, stacked into one rectangle where the rows below repeat them:
// fewer boxes, and fewer edges for screen rounding to open.
function rects(sprite: Sprite, rows: string[], colorOf: (hex: string) => number): Rect[] {
  const done: Rect[] = []
  let open = new Map<string, Rect>()
  rows.forEach((row, y) => {
    const still = new Map<string, Rect>()
    let x = 0
    while (x < sprite.w) {
      const color = row.slice(x * 6, x * 6 + 6)
      let end = x + 1
      while (end < sprite.w && row.slice(end * 6, end * 6 + 6) === color) {
        end++
      }
      if (color !== CLEAR) {
        const c = colorOf(color)
        const key = `${x},${end - x},${c}`
        const above = open.get(key)
        const rect = above ?? { x, y, w: end - x, h: 0, c }
        rect.h++
        if (above === undefined) {
          done.push(rect)
        }
        still.set(key, rect)
      }
      x = end
    }
    open = still
  })

  return done
}

// The color most of a block is, or clear where less than half of it is drawn.
function majority(colors: string[], clear: string): string {
  const counts = new Map<string, number>()
  for (const c of colors) {
    if (c !== clear) {
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
  }
  let best = clear
  let most = 0
  let drawn = 0
  for (const [c, n] of counts) {
    drawn += n
    if (n > most) {
      best = c
      most = n
    }
  }

  return drawn * 2 >= colors.length ? best : clear
}

function blocks<T>(w: number, h: number, k: number, at: (x: number, y: number) => T, x0: number, y0: number): T[] {
  const out: T[] = []
  for (let y = y0 * k; y < Math.min(h, (y0 + 1) * k); y++) {
    for (let x = x0 * k; x < Math.min(w, (x0 + 1) * k); x++) {
      out.push(at(x, y))
    }
  }

  return out
}

function downsample(sprite: Sprite, k: number): Sprite {
  const w = Math.ceil(sprite.w / k)
  const h = Math.ceil(sprite.h / k)
  const frames = sprite.frames.map(rows =>
    Array.from({ length: h }, (_, by) =>
      Array.from({ length: w }, (_, bx) =>
        majority(blocks(sprite.w, sprite.h, k, (x, y) => rows[y]?.slice(x * 6, x * 6 + 6) ?? CLEAR, bx, by), CLEAR),
      ).join(''),
    ),
  )

  return { w, h, loop: sprite.loop, frames }
}

function encode(id: number, sprite: Sprite, frames: string[][], scale: number): PetSprite {
  const palette: string[] = []
  const index = new Map<string, number>()
  const colorOf = (hex: string) => {
    if (!index.has(hex)) {
      index.set(hex, palette.length)
      palette.push(`#${hex}`)
    }
    return index.get(hex) ?? 0
  }
  const hex2 = (n: number) => n.toString(16).padStart(2, '0')
  const encoded = frames.map(rows =>
    rects(sprite, rows, colorOf)
      .map(r => hex2(r.x) + hex2(r.y) + hex2(r.w) + hex2(r.h) + hex2(r.c))
      .join(''),
  )

  return { id, w: sprite.w, h: sprite.h, scale, loop: sprite.loop, palette, frames: encoded }
}

// At the finest scale whose every frame is MAX_RECTS boxes or fewer, the most evenly spaced
// frames that fit a Client's props, or undefined.
export function encodeSprite(id: number, source: Sprite): PetSprite | undefined {
  for (let scale = 1; scale <= Math.max(source.w, source.h); scale++) {
    const sprite = scale === 1 ? source : downsample(source, scale)
    if (encode(id, sprite, sprite.frames, scale).frames.some(f => f.length / 10 > MAX_RECTS)) {
      continue
    }
    for (let n = sprite.frames.length; n >= 1; n--) {
      const frames = Array.from({ length: n }, (_, i) => sprite.frames[Math.floor((i * sprite.frames.length) / n)] ?? [])
      const pet = encode(id, sprite, frames, scale)
      // Two hex digits name a color, so 256 at most.
      if (pet.palette.length <= 256 && JSON.stringify({ sprite: pet }).length <= PROPS_LIMIT) {
        return pet
      }
    }
  }

  return undefined
}

// One decoded rectangle of a PetSprite frame.
export type Fill = [x: number, y: number, w: number, h: number, c: number]
const parsed = new WeakMap<PetSprite, Fill[][]>()

export function rectsOf(sprite: PetSprite): Fill[][] {
  let frames = parsed.get(sprite)
  if (frames === undefined) {
    frames = sprite.frames.map(runs =>
      Array.from({ length: Math.floor(runs.length / 10) }, (_, i) =>
        [0, 2, 4, 6, 8].map(at => parseInt(runs.slice(i * 10 + at, i * 10 + at + 2), 16)) as Fill),
    )
    parsed.set(sprite, frames)
  }

  return frames
}

export function parseArg(text: string): { id: number; shiny: boolean } | undefined {
  const [number, variant, ...rest] = text.trim().split(/\s+/)
  const id = Number(number)
  const known = (variant === undefined || variant === 'shiny') && rest.length === 0

  // No upper bound: forms run past the dex (10001 on), and sprite.py says which numbers have no sprite.
  return known && Number.isSafeInteger(id) && id >= 1 ? { id, shiny: variant === 'shiny' } : undefined
}
