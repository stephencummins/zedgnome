/**
 * Any dropped file → Audio at 44.1 kHz. The browser decodes (and resamples)
 * what it can; AIFF, which Chrome cannot decode, goes through our own reader.
 */
import { decodeAiff, isAiff } from '../opz/aiff'
import { TARGET } from '../opz/layout'
import { type Audio, decodeWav } from '../opz/wav'

export async function decodeAny(bytes: Uint8Array): Promise<Audio> {
  if (isAiff(bytes)) return decodeAiff(bytes)
  try {
    const ctx = new OfflineAudioContext(1, 1, TARGET.sampleRate)
    const buffer = await ctx.decodeAudioData(bytes.slice().buffer)
    return {
      sampleRate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice()),
    }
  } catch {
    try {
      return decodeWav(bytes).audio
    } catch {
      throw new Error('could not decode — try wav, aiff or mp3')
    }
  }
}

let ctx: AudioContext | undefined
let playing: AudioBufferSourceNode | undefined
const voices = new Set<AudioBufferSourceNode>()

/** The audio context, made or woken. Call it from a click before sound has to start without one (MIDI). */
export function wake(): AudioContext {
  ctx ??= new AudioContext()
  void ctx.resume()
  return ctx
}

/**
 * Plays a sound, cutting off whatever was playing. `onEnd` runs only when the
 * sound reaches its end by itself, not when stop() or another play() cuts it.
 * `rate` 2 plays it an octave up.
 */
export function play(audio: Audio, onEnd?: () => void, rate = 1) {
  const ctx = wake()
  stop()
  const buffer = ctx.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate)
  audio.channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.playbackRate.value = rate
  node.connect(ctx.destination)
  node.onended = () => {
    if (playing !== node) return
    playing = undefined
    onEnd?.()
  }
  node.start()
  playing = node
}

const buffers = new WeakMap<Float32Array, AudioBuffer>()

/**
 * One note on top of whatever else is sounding, for chords off a MIDI keyboard
 * and held computer keys. Returns the note's release; a sound left alone plays
 * to its end.
 */
export function voice(samples: Float32Array, rate = 1): () => void {
  const ctx = wake()
  let buffer = buffers.get(samples)
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.max(1, samples.length), TARGET.sampleRate)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    buffers.set(samples, buffer)
  }
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.playbackRate.value = rate
  const amp = ctx.createGain()
  node.connect(amp).connect(ctx.destination)
  node.onended = () => voices.delete(node)
  node.start()
  voices.add(node)
  return () => {
    if (!voices.has(node)) return
    amp.gain.setTargetAtTime(0, ctx.currentTime, 0.03)
    node.stop(ctx.currentTime + 0.2)
  }
}

/** Silence: the playing sound and every voice. */
export function stop() {
  const node = playing
  playing = undefined
  node?.stop()
  for (const v of voices) v.stop()
  voices.clear()
}
