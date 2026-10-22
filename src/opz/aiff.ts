/**
 * AIFF in. Chrome's decodeAudioData does not read AIFF, and a lot of sample
 * packs (and the SX's own exports) are AIFF, so this reads plain AIFF and the
 * uncompressed flavours of AIFF-C itself.
 */
import type { Audio } from './wav'

export class AiffError extends Error {}

export function isAiff(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(bytes, 8, 4))
}

export function decodeAiff(bytes: Uint8Array): Audio {
  if (!isAiff(bytes)) throw new AiffError('That is not an aiff file.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const aifc = ascii(bytes, 8, 4) === 'AIFC'

  let channelCount = 0
  let frames = 0
  let bitDepth = 0
  let sampleRate = 0
  let littleEndian = false
  let float = false
  let dataStart = -1

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4)
    const body = offset + 8
    if (id === 'COMM') {
      channelCount = view.getUint16(body)
      frames = view.getUint32(body + 2)
      bitDepth = view.getUint16(body + 6)
      sampleRate = extended(view, body + 8)
      if (aifc && size >= 22) {
        const kind = ascii(bytes, body + 18, 4)
        if (kind === 'sowt') littleEndian = true
        else if (kind === 'fl32' || kind === 'FL32') float = true
        else if (kind !== 'NONE' && kind !== 'twos') {
          throw new AiffError(`This aiff is compressed (${kind.trim()}). Re-export it uncompressed.`)
        }
      }
    } else if (id === 'SSND') {
      dataStart = body + 8 + view.getUint32(body) // skip offset + blockSize
    }
    offset = body + size + (size % 2)
  }

  if (dataStart < 0 || !channelCount || !sampleRate) throw new AiffError('This aiff is missing its COMM or SSND chunk.')
  if (![8, 16, 24, 32].includes(bitDepth)) throw new AiffError(`${bitDepth}-bit aiff is not supported.`)

  const width = bitDepth / 8
  frames = Math.min(frames, Math.floor((bytes.byteLength - dataStart) / (width * channelCount)))
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const at = dataStart + (f * channelCount + ch) * width
      channels[ch][f] = read(view, at, bitDepth, littleEndian, float)
    }
  }
  return { sampleRate: Math.round(sampleRate), channels }
}

function read(view: DataView, at: number, bitDepth: number, le: boolean, float: boolean): number {
  if (float) return view.getFloat32(at, le)
  switch (bitDepth) {
    case 8:
      return view.getInt8(at) / 128 // aiff 8-bit is signed, unlike wav
    case 16:
      return view.getInt16(at, le) / 32768
    case 24: {
      const [a, b, c] = [view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2)]
      const raw = le ? a | (b << 8) | (c << 16) : (a << 16) | (b << 8) | c
      return (raw & 0x800000 ? raw - 0x1000000 : raw) / 8388608
    }
    default:
      return view.getInt32(at, le) / 2147483648
  }
}

/** The 80-bit IEEE extended float AIFF keeps its sample rate in. */
function extended(view: DataView, at: number): number {
  const exponent = view.getUint16(at) & 0x7fff
  const hi = view.getUint32(at + 2)
  const lo = view.getUint32(at + 6)
  if (exponent === 0 && hi === 0 && lo === 0) return 0
  return (hi * 2 ** 32 + lo) * 2 ** (exponent - 16383 - 63)
}

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...bytes.subarray(at, at + length))
