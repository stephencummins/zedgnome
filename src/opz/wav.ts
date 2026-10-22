/**
 * WAV in, WAV out. Lifted from Mic Gnome's codec (same author), minus the
 * fx-mic limits.
 *
 * Everything here is pure and works on plain arrays, so it runs in tests
 * without an AudioContext.
 */

export interface Audio {
  sampleRate: number
  /** One Float32Array per channel, -1 to 1. */
  channels: Float32Array[]
}

export interface WavFormat {
  sampleRate: number
  channelCount: number
  bitDepth: 8 | 16 | 24 | 32
  float: boolean
  frames: number
  duration: number
}

export class WavError extends Error {}

const HEADER_BYTES = 44

/** Exact byte size of a wav with these properties. No guessing, no fudge factor. */
export function wavBytes(frames: number, channelCount: number, bitDepth: number): number {
  return HEADER_BYTES + frames * channelCount * (bitDepth / 8)
}

// ------------------------------------------------------------------ decode

export function decodeWav(bytes: Uint8Array): { audio: Audio; format: WavFormat } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new WavError('That is not a wav file.')
  }

  let audioFormat = 0
  let channelCount = 0
  let sampleRate = 0
  let bitDepth = 0
  let dataStart = -1
  let dataLength = 0

  // Walk the chunks. Real files carry LIST, fact and others between fmt and data.
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true)
      channelCount = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitDepth = view.getUint16(body + 14, true)
      if (audioFormat === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE hides the real format in its GUID's first two bytes.
        audioFormat = view.getUint16(body + 24, true)
      }
    } else if (id === 'data') {
      dataStart = body
      // Some encoders write a placeholder length; trust the file's actual extent.
      dataLength = Math.min(size, bytes.byteLength - body)
    }

    offset = body + size + (size % 2) // chunks are word-aligned
  }

  if (dataStart < 0 || !channelCount || !sampleRate || !bitDepth) {
    throw new WavError('This wav is missing its format or data chunk.')
  }

  const float = audioFormat === 3
  if (audioFormat !== 1 && !float) {
    throw new WavError(
      `This wav is compressed (format ${audioFormat}). Re-export it as PCM wav.`,
    )
  }
  if (![8, 16, 24, 32].includes(bitDepth)) {
    throw new WavError(`${bitDepth}-bit is not a depth this reads. Use 8, 16, 24 or 32-bit.`)
  }

  const bytesPerSample = bitDepth / 8
  const frames = Math.floor(dataLength / (channelCount * bytesPerSample))
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))

  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const at = dataStart + (frame * channelCount + ch) * bytesPerSample
      channels[ch][frame] = readSample(view, at, bitDepth, float)
    }
  }

  return {
    audio: { sampleRate, channels },
    format: {
      sampleRate,
      channelCount,
      bitDepth: bitDepth as WavFormat['bitDepth'],
      float,
      frames,
      duration: frames / sampleRate,
    },
  }
}

function readSample(view: DataView, at: number, bitDepth: number, float: boolean): number {
  if (float) return view.getFloat32(at, true)
  switch (bitDepth) {
    case 8:
      return (view.getUint8(at) - 128) / 128 // 8-bit wav is unsigned, unlike every other depth
    case 16:
      return view.getInt16(at, true) / 32768
    case 24: {
      const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16)
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608
    }
    default:
      return view.getInt32(at, true) / 2147483648
  }
}

// ------------------------------------------------------------------ encode

export function encodeWav(audio: Audio, bitDepth: 8 | 16 | 24 | 32, float = false): Uint8Array {
  const channelCount = audio.channels.length
  const frames = audio.channels[0]?.length ?? 0
  const bytesPerSample = bitDepth / 8
  const dataBytes = frames * channelCount * bytesPerSample
  const out = new Uint8Array(HEADER_BYTES + dataBytes)
  const view = new DataView(out.buffer)

  writeAscii(out, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(out, 8, 'WAVE')
  writeAscii(out, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, float ? 3 : 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, audio.sampleRate, true)
  view.setUint32(28, audio.sampleRate * channelCount * bytesPerSample, true) // byte rate
  view.setUint16(32, channelCount * bytesPerSample, true) // block align
  view.setUint16(34, bitDepth, true)
  writeAscii(out, 36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const at = HEADER_BYTES + (frame * channelCount + ch) * bytesPerSample
      writeSample(view, at, audio.channels[ch][frame], bitDepth, float)
    }
  }
  return out
}

function writeSample(view: DataView, at: number, value: number, bitDepth: number, float: boolean) {
  if (float) {
    view.setFloat32(at, value, true)
    return
  }
  const v = Math.max(-1, Math.min(1, value))
  switch (bitDepth) {
    case 8:
      view.setUint8(at, Math.round(v * 127) + 128)
      break
    case 16:
      view.setInt16(at, Math.round(v * 32767), true)
      break
    case 24: {
      const n = Math.round(v * 8388607)
      const u = n < 0 ? n + 0x1000000 : n
      view.setUint8(at, u & 0xff)
      view.setUint8(at + 1, (u >> 8) & 0xff)
      view.setUint8(at + 2, (u >> 16) & 0xff)
      break
    }
    default:
      view.setInt32(at, Math.round(v * 2147483647), true)
  }
}

// --------------------------------------------------------------- transform

/** Averages channels down to one. For sound effects this is usually free. */
export function toMono(audio: Audio): Audio {
  if (audio.channels.length === 1) return audio
  const frames = audio.channels[0].length
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (const channel of audio.channels) sum += channel[i]
    out[i] = sum / audio.channels.length
  }
  return { sampleRate: audio.sampleRate, channels: [out] }
}

/**
 * Linear interpolation. Only the fallback: in the browser, decodeAudioData on a
 * 44.1 kHz context does the resampling, and does it better.
 */
export function resample(audio: Audio, rate: number): Audio {
  if (rate === audio.sampleRate) return audio
  const ratio = rate / audio.sampleRate
  const frames = Math.max(1, Math.round(audio.channels[0].length * ratio))
  const channels = audio.channels.map((source) => {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      const at = i / ratio
      const low = Math.floor(at)
      const high = Math.min(low + 1, source.length - 1)
      const t = at - low
      out[i] = source[low] * (1 - t) + source[high] * t
    }
    return out
  })
  return { sampleRate: rate, channels }
}

export function slice(audio: Audio, startFrame: number, endFrame: number): Audio {
  const from = Math.max(0, Math.floor(startFrame))
  const to = Math.min(audio.channels[0].length, Math.ceil(endFrame))
  return { sampleRate: audio.sampleRate, channels: audio.channels.map((c) => c.slice(from, to)) }
}

/**
 * Finds the sound. Leading silence before a transient and a long tail of
 * near-nothing are the cheapest bytes to give back, because losing them is not
 * a quality trade at all.
 */
export function findSound(audio: Audio, threshold = 0.005): { start: number; end: number } {
  const frames = audio.channels[0]?.length ?? 0
  const peakAt = (i: number) => Math.max(...audio.channels.map((c) => Math.abs(c[i])))

  let start = 0
  while (start < frames && peakAt(start) < threshold) start++
  let end = frames
  while (end > start && peakAt(end - 1) < threshold) end--

  if (start >= end) return { start: 0, end: frames } // all quiet: do not "trim" it to nothing

  // Keep a few milliseconds before the transient so the attack is not clipped.
  const pad = Math.round(audio.sampleRate * 0.005)
  return { start: Math.max(0, start - pad), end: Math.min(frames, end + pad) }
}

export function peak(audio: Audio): number {
  let max = 0
  for (const channel of audio.channels) {
    for (const v of channel) max = Math.max(max, Math.abs(v))
  }
  return max
}

/** A coarse waveform for drawing, one peak per bucket. */
export function envelope(audio: Audio, buckets = 120): number[] {
  const frames = audio.channels[0]?.length ?? 0
  if (!frames) return []
  const size = Math.max(1, Math.floor(frames / buckets))
  const out: number[] = []
  for (let b = 0; b < buckets; b++) {
    let max = 0
    for (let i = b * size; i < Math.min((b + 1) * size, frames); i++) {
      for (const channel of audio.channels) max = Math.max(max, Math.abs(channel[i]))
    }
    out.push(max)
  }
  return out
}

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length))

function writeAscii(bytes: Uint8Array, at: number, text: string) {
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i)
}
