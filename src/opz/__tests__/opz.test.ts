import { describe, expect, it } from 'vitest'
import { decodeAiff } from '../aiff'
import { freeName, inspect, lastImport, memoryDir, readSlotFile, writeKit } from '../disk'
import { PER_FRAME, encodeDrumKit, kitSlices, readMeta, toPosition } from '../drumkit'
import { type Sound, frames, kitFrames, layOut, render, toSound } from '../kit'
import { KEYS, MAX_FRAMES, kitFileName, leadingNumber } from '../layout'

const tone = (rate: number, n: number, amp = 0.5, channels = 1) => ({
  sampleRate: rate,
  channels: Array.from({ length: channels }, () => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(i / 10))),
})
const sound = (n: number, over: Partial<Sound> = {}): Sound => ({ ...toSound('hit.wav', tone(44100, n), false), ...over })
const keys = (...ss: (Sound | undefined)[]) => [...ss, ...Array(KEYS - ss.length).fill(undefined)]

describe('layout', () => {
  it('reads folder numbers either way they are written', () => {
    expect(leadingNumber('1-kick')).toBe(1)
    expect(leadingNumber('01')).toBe(1)
    expect(leadingNumber('10')).toBe(10)
    expect(leadingNumber('4 sample')).toBe(4)
    expect(leadingNumber('rejected')).toBeUndefined()
    expect(leadingNumber('123')).toBeUndefined()
  })
  it('makes safe kit file names', () => {
    expect(kitFileName('My Kit!/../x.aiff')).toBe('my-kitx.aif')
    expect(kitFileName('')).toBe('kit.aif')
  })
})

describe('kit', () => {
  it('brings anything to mono 44.1k, normalised, with silence trimmed', () => {
    const quiet = { sampleRate: 48000, channels: [new Float32Array(4800), new Float32Array(4800)] }
    quiet.channels.forEach((c) => c.set(Float32Array.from({ length: 480 }, (_, i) => 0.1 * Math.sin(i / 5)), 2400))
    const s = toSound('snare.wav', quiet)
    expect(s.name).toBe('snare')
    expect(s.source.length).toBeLessThan(1000)
    expect(Math.max(...s.source.map(Math.abs))).toBeCloseTo(10 ** (-0.3 / 20), 2)
  })
  it('bakes trim, pitch and reverse into the length', () => {
    expect(frames(sound(4410, { start: 1000, end: 3000 }))).toBe(2000)
    expect(render(sound(4410, { pitch: 12 })).length).toBe(2205)
    expect(frames(sound(4410, { pitch: 12 }))).toBe(2205)
    expect(frames(sound(4410, { pitch: -12 }))).toBe(8820)
    const fwd = render(sound(4410))
    const back = render(sound(4410, { reverse: true }))
    expect(back[200]).toBeCloseTo(fwd[4410 - 1 - 200], 1)
  })
  it('fades the ends so no slice clicks', () => {
    const r = render(sound(4410, { gain: 6 }))
    expect(r[0]).toBe(0)
    expect(r[r.length - 1]).toBe(0)
    expect(Math.max(...r)).toBeLessThanOrEqual(1)
  })
  it('lays keys end to end, skipping empty ones, and knows when it is over 12 s', () => {
    const laid = layOut(keys(sound(1000), undefined, sound(500)))
    expect(laid.spans[0]).toEqual({ start: 0, end: 1000 })
    expect(laid.spans[1]).toBeUndefined()
    expect(laid.spans[2]).toEqual({ start: 1000, end: 1500 })
    expect(laid.over).toBe(false)
    const big = layOut(keys(sound(MAX_FRAMES - 100), sound(1000)))
    expect(big.over).toBe(true)
    expect(big.audio.length).toBe(MAX_FRAMES)
    expect(kitFrames(keys(sound(MAX_FRAMES - 100), sound(1000)))).toBe(MAX_FRAMES + 900)
  })
})

describe('drum kit aiff', () => {
  const laid = layOut(keys(sound(1000), sound(2000), undefined, sound(441)))
  const bytes = encodeDrumKit('test kit', laid)

  it('is a mono 16-bit 44.1k aiff any reader can open', () => {
    const a = decodeAiff(bytes)
    expect(a.sampleRate).toBe(44100)
    expect(a.channels).toHaveLength(1)
    expect(a.channels[0].length).toBe(3441)
    expect(a.channels[0][500]).toBeCloseTo(laid.audio[500], 3)
  })
  it('keeps the form size and every chunk even', () => {
    const v = new DataView(bytes.buffer)
    expect(v.getUint32(4)).toBe(bytes.byteLength - 8)
    let at = 12
    const ids: string[] = []
    while (at < bytes.byteLength) {
      ids.push(String.fromCharCode(...bytes.subarray(at, at + 4)))
      const size = v.getUint32(at + 4)
      expect(size % 2).toBe(0)
      at += 8 + size
    }
    expect(ids).toEqual(['COMM', 'APPL', 'SSND'])
    expect(at).toBe(bytes.byteLength)
  })
  it('carries the op-1 json, with positions at 4058 a frame', () => {
    const meta = readMeta(bytes)!
    expect(meta).toMatchObject({ type: 'drum', name: 'test kit', drum_version: 2 })
    expect(meta.start!.slice(0, 4)).toEqual([0, 1000 * PER_FRAME, 3441 * PER_FRAME, 3000 * PER_FRAME])
    expect(meta.end!.slice(0, 4)).toEqual([1000 * PER_FRAME, 3000 * PER_FRAME, 3441 * PER_FRAME, 3441 * PER_FRAME])
    expect(meta.start!).toHaveLength(24)
    // Empty keys sit at the end with no length.
    expect(meta.start![23]).toBe(meta.end![23])
    expect(toPosition(MAX_FRAMES)).toBeLessThanOrEqual(2147483646)
  })
  it('reads its own slices back, empty keys left out', () => {
    const slices = kitSlices(readMeta(bytes)!, 3441)
    expect(slices[0]).toEqual({ start: 0, end: 1000 })
    expect(slices[1]).toEqual({ start: 1000, end: 3000 })
    expect(slices[2]).toBeUndefined()
    expect(slices[3]).toEqual({ start: 3000, end: 3441 })
    expect(slices[4]).toBeUndefined()
  })
})

async function opz() {
  const root = memoryDir('OP-Z')
  const packs = (await root.dir('samplepacks', true))!
  for (const t of ['1-kick', '2-snare', '3-perc', '4-fx', '5-bass']) {
    const d = (await packs.dir(t, true))!
    for (let s = 1; s <= 10; s++) await d.dir(String(s).padStart(2, '0'), true)
  }
  return root
}

describe('disk', () => {
  it('refuses a disk with no samplepacks folder', async () => {
    const r = await inspect(memoryDir('USB'))
    expect(r.ok).toBe(false)
    expect(r.problem).toMatch(/content mode/)
    await expect(writeKit(memoryDir(), 1, 1, 'k.aif', new Uint8Array(4))).rejects.toThrow(/nothing was written/)
  })
  it('finds the four drum tracks and their slots', async () => {
    const root = await opz()
    const kick = (await (await (await root.dir('samplepacks'))!.dir('1-kick'))!.dir('03'))!
    await kick.write('boom.aif', new Uint8Array(10))
    await kick.write('.DS_Store', new Uint8Array(1))
    const r = await inspect(root)
    expect(r.ok).toBe(true)
    expect(r.tracks.map((t) => t.folder)).toEqual(['1-kick', '2-snare', '3-perc', '4-fx'])
    expect(r.slots).toHaveLength(40)
    expect(r.slots.find((s) => s.track === 1 && s.slot === 3)!.files).toEqual([{ name: 'boom.aif', bytes: 10, kind: 'kit' }])
  })
  it('accepts the samplepacks folder itself being picked', async () => {
    const root = await opz()
    expect((await inspect((await root.dir('samplepacks'))!)).ok).toBe(true)
  })
  it('replaces what is in the slot, keeping the old kit in the page', async () => {
    const root = await opz()
    const slot = (await (await (await root.dir('samplepacks'))!.dir('2-snare'))!.dir('05'))! as ReturnType<typeof memoryDir>
    await slot.write('old.aif', new Uint8Array([1, 2, 3]))
    const data = new Uint8Array([9, 9, 9, 9])
    const res = await writeKit(root, 2, 5, 'new.aif', data)
    expect(res.path).toBe('samplepacks/2-snare/05/new.aif')
    expect(res.replaced).toEqual([{ name: 'old.aif', data: new Uint8Array([1, 2, 3]) }])
    expect([...slot.files.keys()]).toEqual(['new.aif'])
    expect(await readSlotFile(root, 2, 5, 'new.aif')).toEqual(data)
  })
  it('tells kits on the disk from kits already inside the op-z and factory plugs', async () => {
    const root = await opz()
    const kick = (await (await root.dir('samplepacks'))!.dir('1-kick'))!
    await (await kick.dir('01'))!.write('~13.engine', new Uint8Array(0))
    await (await kick.dir('02'))!.write('~mine.aif', new Uint8Array(0))
    await (await kick.dir('02'))!.write('._~mine.aif', new Uint8Array(4))
    const r = await inspect(root)
    expect(r.slots[0].files).toEqual([{ name: '~13.engine', bytes: 0, kind: 'factory' }])
    expect(r.slots[1].files).toEqual([{ name: '~mine.aif', bytes: 0, kind: 'imported' }])
  })
  it('clears markers and macos litter, and never reuses a name another slot declares', async () => {
    const root = await opz()
    const kick = (await (await root.dir('samplepacks'))!.dir('1-kick'))!
    await (await kick.dir('01'))!.write('~kit.aif', new Uint8Array(0))
    const slot = (await kick.dir('02'))! as ReturnType<typeof memoryDir>
    await slot.write('~13.engine', new Uint8Array(0))
    await slot.write('._old.aif', new Uint8Array(4))
    const res = await writeKit(root, 1, 2, 'kit.aif', new Uint8Array([1, 2]))
    expect(res.written).toBe('kit-2.aif')
    expect(res.replaced).toEqual([])
    expect(res.cleared.map((c) => c.name)).toEqual(['~13.engine'])
    expect([...slot.files.keys()]).toEqual(['kit-2.aif'])
  })
  it('names around clashes, keeping within 24 characters', () => {
    expect(freeName(['other.aif'], 'kit.aif')).toBe('kit.aif')
    expect(freeName(['~KIT.aif', 'kit-2.aif'], 'kit.aif')).toBe('kit-3.aif')
    expect(freeName(['~abcdefghijklmnopqrstuvwx.aif'], 'abcdefghijklmnopqrstuvwx.aif')).toBe('abcdefghijklmnopqrstuv-2.aif')
  })
  it('reads the last import out of import.log', async () => {
    const log = '[IMPORT STARTED]\nold\n[IMPORT COMPLETE]\n[IMPORT STARTED]\n  importing kit.aif...SUCCESS. New used space 870 kB\n[IMPORT COMPLETE]\n'
    expect(lastImport(log)).toEqual(['[IMPORT STARTED]', 'importing kit.aif...SUCCESS. New used space 870 kB', '[IMPORT COMPLETE]'])
    const root = await opz()
    await root.write('import.log', new TextEncoder().encode(log))
    expect((await inspect(root)).importLog).toHaveLength(3)
  })
  it('will not write to a synth track', async () => {
    await expect(writeKit(await opz(), 5, 1, 'k.aif', new Uint8Array(4))).rejects.toThrow(/not a drum track/)
  })
})
