/**
 * The OP-1 / OP-Z drum kit file: a plain AIFF (mono, 16-bit, 44.1 kHz) with
 * an APPL chunk before the sound data holding "op-1" and a line of JSON. The
 * JSON says where each of the 24 keys starts and ends, as a fraction of 12
 * seconds scaled to 2^31: about 4058 per sample frame.
 *
 * Sourced from two MIT tools built against real devices — teoperator (Go, by
 * schollz) and OP-Z-Simple-Tool — not from Teenage Engineering. The defaults
 * below are teoperator's drum_version 2 patch, which people load on the OP-Z.
 */
import { KEYS, MAX_FRAMES, TARGET } from './layout'
import type { Laid } from './kit'

/** 2147483646 / (44100 × 12) ≈ 4058, as teoperator rounds it. */
export const PER_FRAME = 4058
export const MAX_POSITION = 2147483646

export interface DrumMeta {
  drum_version: number
  type: 'drum'
  name: string
  octave: number
  pitch: number[]
  start: number[]
  end: number[]
  playmode: number[]
  reverse: number[]
  volume: number[]
  dyna_env: number[]
  fx_active: boolean
  fx_type: string
  fx_params: number[]
  lfo_active: boolean
  lfo_type: string
  lfo_params: number[]
}

const fill = (v: number) => Array<number>(KEYS).fill(v)

export function defaultMeta(name: string): DrumMeta {
  return {
    drum_version: 2,
    type: 'drum',
    name: name.slice(0, 32),
    octave: 0,
    pitch: fill(0),
    start: fill(0),
    end: fill(0),
    playmode: fill(8192),
    reverse: fill(8192),
    volume: fill(8192),
    dyna_env: [0, 8192, 0, 8192, 0, 0, 0, 0],
    fx_active: false,
    fx_type: 'delay',
    fx_params: Array<number>(8).fill(8000),
    lfo_active: false,
    lfo_type: 'tremolo',
    lfo_params: [16000, 16000, 16000, 16000, 0, 0, 0, 0],
  }
}

export const toPosition = (frame: number) => Math.min(MAX_POSITION, Math.max(0, Math.round(frame) * PER_FRAME))
export const toFrame = (position: number) => Math.round(position / PER_FRAME)

/**
 * The kit's positions. An empty key gets a zero-length slice where the sound
 * ends, so it plays nothing rather than a neighbour.
 */
export function metaFor(name: string, laid: Laid): DrumMeta {
  const meta = defaultMeta(name)
  const tail = laid.audio.length
  laid.spans.forEach((span, i) => {
    meta.start[i] = toPosition(span ? span.start : tail)
    meta.end[i] = toPosition(span ? span.end : tail)
  })
  return meta
}

export function encodeDrumKit(name: string, laid: Laid): Uint8Array {
  return encodeAiff(laid.audio, metaFor(name, laid))
}

/** A mono 16-bit AIFF, with the op-1 APPL chunk when meta is given. */
export function encodeAiff(samples: Float32Array, meta?: DrumMeta): Uint8Array {
  const frames = Math.min(samples.length, MAX_FRAMES)
  let appl = new Uint8Array(0)
  if (meta) {
    const text = 'op-1' + JSON.stringify(meta) + '\n'
    const body = text.length % 2 ? text + ' ' : text
    appl = new Uint8Array(8 + body.length)
    putAscii(appl, 0, 'APPL')
    new DataView(appl.buffer).setUint32(4, body.length)
    putAscii(appl, 8, body)
  }
  const comm = 8 + 18
  const ssnd = 8 + 8 + frames * 2
  const total = 12 + comm + appl.length + ssnd
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  putAscii(out, 0, 'FORM')
  v.setUint32(4, total - 8)
  putAscii(out, 8, 'AIFF')
  let at = 12
  putAscii(out, at, 'COMM')
  v.setUint32(at + 4, 18)
  v.setUint16(at + 8, 1)
  v.setUint32(at + 10, frames)
  v.setUint16(at + 14, TARGET.bitDepth)
  putExtended(v, at + 16, TARGET.sampleRate)
  at += comm
  out.set(appl, at)
  at += appl.length
  putAscii(out, at, 'SSND')
  v.setUint32(at + 4, 8 + frames * 2)
  v.setUint32(at + 8, 0)
  v.setUint32(at + 12, 0)
  at += 16
  for (let i = 0; i < frames; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(at + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767))
  }
  return out
}

/** The op-1 JSON from an AIFF, if it has any. */
export function readMeta(bytes: Uint8Array): Partial<DrumMeta> | undefined {
  if (bytes.byteLength < 12) return undefined
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 12
  while (at + 8 <= bytes.byteLength) {
    const id = ascii(bytes, at, 4)
    const size = v.getUint32(at + 4)
    if (id === 'APPL' && ascii(bytes, at + 8, 4) === 'op-1') {
      const text = ascii(bytes, at + 12, Math.min(size - 4, bytes.byteLength - at - 12))
      try {
        return JSON.parse(text.trim()) as Partial<DrumMeta>
      } catch {
        return undefined
      }
    }
    at += 8 + size + (size % 2)
  }
  return undefined
}

/** A drum kit's slices as frame ranges, empty keys left out. */
export function kitSlices(meta: Partial<DrumMeta>, frames: number): ({ start: number; end: number } | undefined)[] {
  return Array.from({ length: KEYS }, (_, i) => {
    const start = Math.min(frames, toFrame(meta.start?.[i] ?? 0))
    const end = Math.min(frames, toFrame(meta.end?.[i] ?? 0))
    return end - start > 1 ? { start, end } : undefined
  })
}

function putAscii(out: Uint8Array, at: number, s: string) {
  for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i) & 0xff
}

const ascii = (bytes: Uint8Array, at: number, length: number) => {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[at + i])
  return s
}

/** The 80-bit IEEE extended float AIFF keeps its sample rate in (whole numbers only). */
function putExtended(v: DataView, at: number, n: number) {
  const exp = Math.floor(Math.log2(n))
  v.setUint16(at, exp + 16383)
  const mantissa = n / 2 ** exp // 1 ≤ m < 2
  const hi = Math.floor(mantissa * 2 ** 31)
  v.setUint32(at + 2, hi)
  v.setUint32(at + 6, 0)
}
