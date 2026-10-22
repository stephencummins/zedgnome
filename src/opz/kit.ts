/**
 * A kit as you build it: up to 24 sounds, each with its own trim, pitch, gain
 * and reverse. Everything is baked into the audio rather than left to the
 * kit's settings, so the OP-Z plays exactly what the preview plays and nothing
 * depends on how it reads the unverified parts of the format. That is also
 * why pitching a sound up makes it shorter: the 12 seconds are honest.
 */
import { MAX_FRAMES, TARGET } from './layout'
import { type Audio, findSound, peak, resample, slice, toMono } from './wav'

export interface Sound {
  name: string
  /** Mono, 44.1 kHz, normalised when it came in. */
  source: Float32Array
  /** Trim, as frames of the source. */
  start: number
  end: number
  /** Semitones, -12 to +12. */
  pitch: number
  /** Decibels, -24 to +12. */
  gain: number
  reverse: boolean
}

const CEILING = 10 ** (-0.3 / 20)
/** Short fades so no slice starts or stops on a click. */
const FADE_IN = 16
const FADE_OUT = 96

/** Anything decoded → a sound ready to place: mono, 44.1 kHz, silence trimmed, normalised. */
export function toSound(name: string, audio: Audio, trim = true): Sound {
  let a = toMono(resample(audio, TARGET.sampleRate))
  if (trim) {
    const { start, end } = findSound(a)
    if (end > start) a = slice(a, start, end)
  }
  const p = peak(a)
  const gain = p > 0 ? CEILING / p : 1
  const source = a.channels[0].map((v) => v * gain)
  return { name: name.replace(/\.[^.]+$/, ''), source, start: 0, end: source.length, pitch: 0, gain: 0, reverse: false }
}

/** The samples this sound puts in the kit, exactly. */
export function render(s: Sound): Float32Array {
  const start = clamp(Math.round(s.start), 0, s.source.length)
  const end = clamp(Math.round(s.end), start, s.source.length)
  let out: Float32Array = s.source.slice(start, end)
  if (s.pitch) {
    // Up an octave plays twice as fast, so takes half the frames.
    const ratio = 2 ** (s.pitch / 12)
    out = resample({ sampleRate: Math.round(TARGET.sampleRate * ratio), channels: [out] }, TARGET.sampleRate).channels[0]
  }
  if (s.reverse) out.reverse()
  const g = 10 ** (s.gain / 20)
  const n = out.length
  for (let i = 0; i < n; i++) {
    let v = out[i] * g
    if (i < FADE_IN) v *= i / FADE_IN
    if (n - i <= FADE_OUT) v *= (n - 1 - i) / FADE_OUT
    out[i] = Math.max(-1, Math.min(1, v))
  }
  return out
}

/** How many frames the sound takes in the kit, without rendering it. */
export function frames(s: Sound): number {
  const len = clamp(Math.round(s.end), 0, s.source.length) - clamp(Math.round(s.start), 0, s.source.length)
  return Math.max(0, s.pitch ? Math.round(len / 2 ** (s.pitch / 12)) : len)
}

/** The kit's keys rendered and laid end to end, with where each one starts and ends. */
export interface Laid {
  audio: Float32Array
  /** Per key, frames into the audio; undefined for an empty key. */
  spans: ({ start: number; end: number } | undefined)[]
  total: number
  over: boolean
}

export function layOut(keys: (Sound | undefined)[]): Laid {
  const parts = keys.map((s) => (s ? render(s) : undefined))
  const total = parts.reduce((t, p) => t + (p?.length ?? 0), 0)
  const audio = new Float32Array(Math.min(total, MAX_FRAMES))
  let at = 0
  const spans = parts.map((p) => {
    if (!p) return undefined
    const start = Math.min(at, MAX_FRAMES)
    audio.set(p.subarray(0, Math.max(0, MAX_FRAMES - start)), start)
    at += p.length
    return { start, end: Math.min(at, MAX_FRAMES) }
  })
  return { audio, spans, total, over: total > MAX_FRAMES }
}

/** Frames the kit will take, cheaply, for the meter. */
export const kitFrames = (keys: (Sound | undefined)[]) => keys.reduce((t, s) => t + (s ? frames(s) : 0), 0)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
