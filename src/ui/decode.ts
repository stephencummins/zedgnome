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

/**
 * Plays a sound, cutting off whatever was playing. `onEnd` runs only when the
 * sound reaches its end by itself, not when stop() or another play() cuts it.
 */
export function play(audio: Audio, onEnd?: () => void) {
  ctx ??= new AudioContext()
  void ctx.resume()
  stop()
  const buffer = ctx.createBuffer(audio.channels.length, audio.channels[0].length, audio.sampleRate)
  audio.channels.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i))
  const node = ctx.createBufferSource()
  node.buffer = buffer
  node.connect(ctx.destination)
  node.onended = () => {
    if (playing !== node) return
    playing = undefined
    onEnd?.()
  }
  node.start()
  playing = node
}

export function stop() {
  const node = playing
  playing = undefined
  node?.stop()
}
