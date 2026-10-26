/**
 * The OP-1 / OP-Z synth sample: one sound the keys play at different pitches.
 * It is the same AIFF as a drum kit, with "sampler" JSON in place of the drum
 * JSON. base_freq is the pitch the sound was recorded at, so the device can
 * play it in tune with the other tracks.
 *
 * The JSON is teoperator's default sampler patch (src/op1/synth.go), which
 * ioma8/opz-firmware-notes' opz_sample_format.py also writes. The 6-second
 * limit is from the latter and from OP-Z owners on Elektronauts, who also
 * report that a shorter sample plays leftover sound past its end with the
 * release open. So every sample is padded with silence to the full 6 seconds.
 */
import { encodeAiff } from './drumkit'
import { SYNTH_FRAMES, TARGET } from './layout'

export interface SynthMeta {
  adsr: number[]
  base_freq: number
  fx_active: boolean
  fx_params: number[]
  fx_type: string
  knobs: number[]
  lfo_active: boolean
  lfo_params: number[]
  lfo_type: string
  name: string
  octave: number
  synth_version: number
  type: 'sampler'
}

export function synthMeta(name: string, baseFreq: number): SynthMeta {
  return {
    adsr: [512, 10746, 32767, 10000, 4000, 64, 4000, 4000],
    base_freq: baseFreq,
    fx_active: false,
    fx_params: [4480, 15544, 10788, 12104, 0, 0, 0, 0],
    fx_type: 'delay',
    knobs: [0, 0, 32767, 32767, 12000, 0, 0, 8304],
    lfo_active: false,
    lfo_params: [11840, 18431, 1024, 15144, 0, 0, 0, 0],
    lfo_type: 'random',
    name: name.slice(0, 32),
    octave: 0,
    synth_version: 1,
    type: 'sampler',
  }
}

/** The sample padded with silence to 6 s, or cut there. */
export function encodeSynth(name: string, samples: Float32Array, baseFreq: number): Uint8Array {
  const padded = new Float32Array(SYNTH_FRAMES)
  padded.set(samples.subarray(0, SYNTH_FRAMES))
  return encodeAiff(padded, synthMeta(name, baseFreq), SYNTH_FRAMES)
}

export const noteFreq = (midi: number) => 440 * 2 ** ((midi - 69) / 12)
export const freqNote = (hz: number) => 69 + 12 * Math.log2(hz / 440)
export const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
/** 60 → "c4". */
export const noteName = (midi: number) => `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`

/** Middle C, teoperator's base_freq when it is not told one. */
export const DEFAULT_ROOT = noteFreq(60)

/**
 * The pitch a sound is at, in Hz, or undefined when it has none clear enough
 * to tune by (a drum, noise). YIN (de Cheveigné and Kawahara, 2002) over one
 * window just after the attack, from 40 Hz to 2 kHz.
 */
export function detectPitch(x: Float32Array, rate: number = TARGET.sampleRate): number | undefined {
  const W = 2048
  const minLag = Math.floor(rate / 2000)
  const maxLag = Math.ceil(rate / 40)
  const from = Math.min(Math.round(rate * 0.05), x.length - W - maxLag - 1)
  if (from < 0) return undefined
  let energy = 0
  for (let i = from; i < from + W; i++) energy += x[i] * x[i]
  if (energy / W < 1e-6) return undefined

  // The cumulative mean normalised difference: dips toward 0 at the period.
  const d = new Float32Array(maxLag + 2)
  d[0] = 1
  let sum = 0
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = from; i < from + W; i++) {
      const v = x[i] - x[i + lag]
      s += v * v
    }
    sum += s
    d[lag] = sum ? (s * lag) / sum : 1
  }
  let best = -1
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (d[lag] < 0.15) {
      while (lag < maxLag && d[lag + 1] < d[lag]) lag++
      best = lag
      break
    }
  }
  if (best < 1) return undefined
  // A parabola through the dip and its neighbours finds the period between samples.
  const [a, b, c] = [d[best - 1], d[best], d[best + 1]]
  const bend = a - 2 * b + c
  const shift = bend ? (a - c) / (2 * bend) : 0
  return rate / (best + shift)
}
