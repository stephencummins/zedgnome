import type { Sound } from '../opz/kit'

/**
 * The kit's bit-art, tiled faintly down the page margins the way TDMDNE tiles
 * its beat and Pad Gnome its bank. A one-dimensional cellular automaton: the
 * first row is the kit's 24 keys squeezed onto sixteen columns, and each row
 * after grows from the one above by an elementary rule the kit's contents pick.
 * Each key's column takes a colour from what has been done to it.
 *
 * Only the sounds and their settings feed it, so every change to the kit grows
 * a new picture.
 */

/** The chaotic and complex rules, as in TDMDNE: the rest settle into stripes or fill in. */
export const ART_RULES = [30, 45, 73, 86, 89, 105, 110, 124, 135, 137, 149, 150, 193]

export type ArtTone = 'filter' | 'space' | 'pitch' | 'drive' | 'ink'

/** A key as the art sees it; undefined is an empty key. */
export interface ArtKey {
  name: string
  tone: ArtTone
}

export interface Art {
  /** 16 rows of 16 cells, 1 = drawn. */
  cells: number[][]
  /** Each column's colour, from the key that seeded it; null between keys and on empty ones. */
  own: (ArtTone | null)[]
  /** The one cell drawn in orange. */
  spark: [number, number] | null
  rule: number
}

/** Reversed is pitch, pitched is space, pushed past 0 dB is drive, as it came is filter. */
export function keyTone(s: Sound): ArtTone {
  if (s.reverse) return 'pitch'
  if (s.pitch) return 'space'
  if (s.gain > 0) return 'drive'
  return 'filter'
}

/** Key 1 on column 0, key 24 on column 15, the rest spread evenly between. */
export const keyColumn = (i: number) => Math.round((i * 15) / 23)

/** FNV-1a, enough to turn the kit's contents into a seed. */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function kitArt(name: string, keys: (ArtKey | undefined)[]): Art {
  const R = mulberry32(hash(JSON.stringify([name, keys.map((k) => (k ? [k.tone, k.name] : 0))])))
  const rule = ART_RULES[Math.floor(R() * ART_RULES.length)]

  const own: (ArtTone | null)[] = Array(16).fill(null)
  keys.slice(0, 24).forEach((k, i) => {
    if (k) own[keyColumn(i)] = k.tone
  })

  // An empty kit still gets a picture of its own, grown from one cell.
  let row: number[] = own.map((t) => (t ? 1 : 0))
  if (!row.some(Boolean)) row[Math.floor(R() * 16)] = 1
  const cells: number[][] = []
  for (let y = 0; y < 16; y++) {
    cells.push(row)
    const prev = row
    row = prev.map((_, x) => (rule >> ((prev[(x + 15) % 16] << 2) | (prev[x] << 1) | prev[(x + 1) % 16])) & 1)
  }
  const hot = cells.flatMap((r, y) => r.flatMap((c, x) => (c ? [[x, y] as [number, number]] : [])))
  return { cells, own, spark: hot.length ? hot[Math.floor(R() * hot.length)] : null, rule }
}

/**
 * Paint the art onto a canvas and hand back a PNG data URL, colours read off
 * the live theme. Undefined where there is no canvas (tests, very old browsers).
 */
export function artUrl(art: Art, cell = 28): string | undefined {
  if (typeof document === 'undefined') return undefined
  const cvs = document.createElement('canvas')
  const ctx = cvs.getContext?.('2d')
  if (!ctx) return undefined
  const css = getComputedStyle(document.documentElement)
  const colour = (name: string) => css.getPropertyValue(`--color-${name}`).trim() || '#888'
  const size = 16 * cell
  cvs.width = cvs.height = size
  art.cells.forEach((r, y) =>
    r.forEach((c, x) => {
      if (!c) return
      const spark = art.spark && art.spark[0] === x && art.spark[1] === y
      ctx.fillStyle = colour(spark ? 'orange' : (art.own[x] ?? 'ink'))
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }),
  )
  return cvs.toDataURL('image/png')
}
