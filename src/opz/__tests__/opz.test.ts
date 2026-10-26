import { describe, expect, it } from 'vitest'
import { decodeAiff } from '../aiff'
import { type MemoryDir, freeName, inspect, lastImport, memoryDir, readSlotFile, writeKit } from '../disk'
import { PER_FRAME, encodeDrumKit, kitSlices, readMeta, toPosition } from '../drumkit'
import { type Sound, frames, kitFrames, layOut, render, toSound } from '../kit'
import { KEYS, LOW_NOTE, MAX_FRAMES, SYNTH_FRAMES, TRACKS, isDrumTrack, kitFileName, leadingNumber, noteKey } from '../layout'
import { DEFAULT_ROOT, detectPitch, encodeSynth, freqNote, noteFreq, noteName } from '../synth'

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
  it('has eight tracks, the first four for drums', () => {
    expect(TRACKS.map((t) => t.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(TRACKS.filter((t) => isDrumTrack(t.n)).map((t) => t.n)).toEqual([1, 2, 3, 4])
  })
  it('folds any midi note onto the 24 keys, key 1 at f3', () => {
    expect(noteKey(LOW_NOTE)).toBe(0)
    expect(noteKey(60)).toBe(7)
    expect(noteKey(LOW_NOTE + 23)).toBe(23)
    expect(noteKey(LOW_NOTE + 24)).toBe(0)
    expect(noteKey(LOW_NOTE - 1)).toBe(23)
    expect(noteKey(0)).toBeGreaterThanOrEqual(0)
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

describe('synth sample aiff', () => {
  const a3 = Float32Array.from({ length: 44100 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / 44100))
  const bytes = encodeSynth('test synth', a3, 220)

  it('is padded with silence to 6 s', () => {
    const a = decodeAiff(bytes)
    expect(a.sampleRate).toBe(44100)
    expect(a.channels).toHaveLength(1)
    expect(a.channels[0]).toHaveLength(SYNTH_FRAMES)
    expect(Math.abs(a.channels[0][1000])).toBeGreaterThan(0)
    expect(a.channels[0].subarray(44100).every((v) => v === 0)).toBe(true)
  })
  it('cuts anything longer at 6 s', () => {
    expect(decodeAiff(encodeSynth('long', new Float32Array(SYNTH_FRAMES + 5000).fill(0.1), 220)).channels[0]).toHaveLength(SYNTH_FRAMES)
  })
  it('carries sampler json with its root', () => {
    const meta = readMeta(bytes)!
    expect(meta.type).toBe('sampler')
    expect(meta.name).toBe('test synth')
    expect(meta.base_freq).toBe(220)
    expect(meta.synth_version).toBe(1)
    expect(meta.adsr).toHaveLength(8)
  })
  it('keeps the form size and every chunk even', () => {
    const v = new DataView(bytes.buffer)
    expect(v.getUint32(4) + 8).toBe(bytes.length)
    for (let at = 12; at < bytes.length;) {
      const size = v.getUint32(at + 4)
      at += 8 + size + (size & 1)
      expect(at % 2).toBe(0)
    }
  })
  it('reads json that other tools padded with odd bytes', () => {
    const json = new TextEncoder().encode('op-1{"type":"sampler","base_freq":110}\n\u0000 ')
    const chunk = new Uint8Array(8 + json.length + (json.length & 1))
    chunk.set(new TextEncoder().encode('APPL'))
    new DataView(chunk.buffer).setUint32(4, json.length)
    chunk.set(json, 8)
    const form = new Uint8Array(12 + chunk.length)
    form.set(new TextEncoder().encode('FORM'))
    new DataView(form.buffer).setUint32(4, form.length - 8)
    form.set(new TextEncoder().encode('AIFF'), 8)
    form.set(chunk, 12)
    expect(readMeta(form)).toMatchObject({ type: 'sampler', base_freq: 110 })
  })
})

describe('pitch', () => {
  const wave = (hz: number, f: (phase: number) => number, n = 22050) =>
    Float32Array.from({ length: n }, (_, i) => 0.5 * f(((hz * i) / 44100) % 1))
  const sine = (p: number) => Math.sin(2 * Math.PI * p)
  const saw = (p: number) => 2 * p - 1
  const cents = (a: number, b: number) => Math.abs(1200 * Math.log2(a / b))

  it('names notes and finds them again', () => {
    expect(noteName(60)).toBe('c4')
    expect(noteName(69)).toBe('a4')
    expect(noteName(53)).toBe('f3')
    expect(noteFreq(69)).toBe(440)
    expect(freqNote(DEFAULT_ROOT)).toBeCloseTo(60)
  })
  it('hears a sine, a saw and a low bass note to within a few cents', () => {
    expect(cents(detectPitch(wave(220, sine))!, 220)).toBeLessThan(5)
    expect(cents(detectPitch(wave(110, saw))!, 110)).toBeLessThan(5)
    expect(cents(detectPitch(wave(55, saw))!, 55)).toBeLessThan(5)
    expect(cents(detectPitch(wave(1046.5, sine))!, 1046.5)).toBeLessThan(10)
  })
  it('hears no note in noise, silence, or a sound too short to tell', () => {
    let seed = 1
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
    expect(detectPitch(Float32Array.from({ length: 22050 }, rand))).toBeUndefined()
    expect(detectPitch(new Float32Array(22050))).toBeUndefined()
    expect(detectPitch(wave(220, sine, 1000))).toBeUndefined()
  })
})

async function opz(opts: { appleDouble?: boolean } = {}) {
  const root = memoryDir('OP-Z', opts)
  const packs = (await root.dir('samplepacks', true))!
  for (const t of ['1-kick', '2-snare', '3-perc', '4-fx', '5-bass', '6-lead', '7-arpeggio', '8-chord']) {
    const d = (await packs.dir(t, true))!
    for (let s = 1; s <= 10; s++) await d.dir(String(s).padStart(2, '0'), true)
  }
  return root
}
const slotOf = async (root: MemoryDir, track: string, slot: string) =>
  (await (await (await root.dir('samplepacks'))!.dir(track))!.dir(slot)) as MemoryDir

describe('disk', () => {
  it('refuses a disk with no samplepacks folder', async () => {
    const r = await inspect(memoryDir('USB'))
    expect(r.ok).toBe(false)
    expect(r.problem).toMatch(/content mode/)
    await expect(writeKit(memoryDir(), 1, 1, 'k.aif', new Uint8Array(4))).rejects.toThrow(/nothing was written/)
  })
  it('finds the eight tracks and their slots', async () => {
    const root = await opz()
    const kick = (await (await (await root.dir('samplepacks'))!.dir('1-kick'))!.dir('03'))!
    await kick.write('boom.aif', new Uint8Array(10))
    await kick.write('.DS_Store', new Uint8Array(1))
    const r = await inspect(root)
    expect(r.ok).toBe(true)
    expect(r.tracks.map((t) => t.folder)).toEqual(['1-kick', '2-snare', '3-perc', '4-fx', '5-bass', '6-lead', '7-arpeggio', '8-chord'])
    expect(r.slots).toHaveLength(80)
    expect(r.slots.find((s) => s.track === 1 && s.slot === 3)!.files).toEqual([{ name: 'boom.aif', bytes: 10 }])
    expect(r.slots.filter((s) => s.hidden)).toEqual([])
  })
  it('accepts the samplepacks folder itself being picked', async () => {
    const root = await opz()
    expect((await inspect((await root.dir('samplepacks'))!)).ok).toBe(true)
  })
  it('replaces what is in the slot, keeping the old kit in the page', async () => {
    const root = await opz()
    await (await slotOf(root, '2-snare', '05')).write('old.aif', new Uint8Array([1, 2, 3]))
    const data = new Uint8Array([9, 9, 9, 9])
    const res = await writeKit(root, 2, 5, 'new.aif', data)
    expect(res.path).toBe('samplepacks/2-snare/05/new.aif')
    expect(res.replaced).toEqual([{ name: 'old.aif', data: new Uint8Array([1, 2, 3]) }])
    expect([...(await slotOf(root, '2-snare', '05')).files.keys()]).toEqual(['new.aif'])
    expect(await readSlotFile(root, 2, 5, 'new.aif')).toEqual(data)
  })
  it('hides ~ markers the way chrome does', async () => {
    const root = await opz()
    const slot = await slotOf(root, '1-kick', '02')
    slot.files.set('~TeKicks.aif', new Uint8Array(0))
    expect(await slot.entries()).toEqual([])
    expect(await slot.read('~TeKicks.aif')).toBeUndefined()
    await expect(slot.remove('~TeKicks.aif')).rejects.toThrow(/not allowed/)
  })
  it('finds slots holding a marker it cannot list, and leaves empty slots in place', async () => {
    const root = await opz()
    ;(await slotOf(root, '1-kick', '02')).files.set('~TeKicks.aif', new Uint8Array(0))
    ;(await slotOf(root, '4-fx', '10')).files.set('~-887013277', new Uint8Array(0))
    const r = await inspect(root)
    expect(r.slots.filter((s) => s.hidden).map((s) => `${s.track}/${s.slot}`)).toEqual(['1/2', '4/10'])
    expect(r.slots.find((s) => s.track === 1 && s.slot === 2)!.files).toEqual([])
    expect(r.slots.every((s) => s.folder)).toBe(true)
    expect(await slotOf(root, '1-kick', '03')).toBeDefined()
  })
  it('clears macos litter from an otherwise empty slot to see into it', async () => {
    const root = await opz()
    const slot = await slotOf(root, '3-perc', '09')
    await slot.write('._gone.aif', new Uint8Array(4))
    await slot.write('.DS_Store', new Uint8Array(4))
    const r = await inspect(root)
    expect(r.slots.find((s) => s.track === 3 && s.slot === 9)!.hidden).toBe(false)
    expect((await slotOf(root, '3-perc', '09')).files.size).toBe(0)
  })
  it('will not write into a slot holding a marker, and puts back a kit it moved', async () => {
    const root = await opz()
    ;(await slotOf(root, '1-kick', '02')).files.set('~TeKicks.aif', new Uint8Array(0))
    await expect(writeKit(root, 1, 2, 'kit.aif', new Uint8Array([1]))).rejects.toThrow(/can't show.*nothing was written/)
    expect([...(await slotOf(root, '1-kick', '02')).files.keys()]).toEqual(['~TeKicks.aif'])

    const both = await slotOf(root, '1-kick', '01')
    both.files.set('~AlainKicks.aif', new Uint8Array(0))
    await both.write('my-kit.aif', new Uint8Array([7, 7]))
    await expect(writeKit(root, 1, 1, 'kit.aif', new Uint8Array([1]))).rejects.toThrow(/nothing was written/)
    expect(both.files.get('my-kit.aif')).toEqual(new Uint8Array([7, 7]))
    expect(both.files.has('kit.aif')).toBe(false)
  })
  it('clears macos litter, leaves none of its own, and never reuses a name another slot uses', async () => {
    const root = await opz({ appleDouble: true })
    await (await slotOf(root, '1-kick', '01')).write('kit.aif', new Uint8Array(1))
    await (await slotOf(root, '1-kick', '02')).write('.DS_Store', new Uint8Array(4))
    const res = await writeKit(root, 1, 2, 'kit.aif', new Uint8Array([1, 2]))
    expect(res.written).toBe('kit-2.aif')
    expect(res.replaced).toEqual([])
    expect([...(await slotOf(root, '1-kick', '02')).files.keys()]).toEqual(['kit-2.aif'])
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
  it('finds the op-z\'s own synths in synth slots', async () => {
    const root = await opz()
    ;(await slotOf(root, '6-lead', '10')).files.set('~10.engine', new Uint8Array(0))
    const r = await inspect(root)
    expect(r.slots.filter((s) => s.hidden).map((s) => `${s.track}/${s.slot}`)).toEqual(['6/10'])
  })
  it('writes a synth sample to a synth track, making a missing slot folder', async () => {
    const root = await opz()
    const arp = (await (await root.dir('samplepacks'))!.dir('7-arpeggio')) as MemoryDir
    arp.dirs.delete('04')
    const data = encodeSynth('pad', new Float32Array(100), 220)
    const res = await writeKit(root, 7, 4, 'pad.aif', data)
    expect(res.path).toBe('samplepacks/7-arpeggio/04/pad.aif')
    expect(res.madeSlot).toBe(true)
    expect(await readSlotFile(root, 7, 4, 'pad.aif')).toEqual(data)
  })
  it('puts kits on drum tracks and synth samples on synth tracks, nowhere else', async () => {
    const root = await opz()
    const kit = encodeDrumKit('kit', layOut(keys(sound(100))))
    const synth = encodeSynth('synth', new Float32Array(100), 220)
    await expect(writeKit(root, 5, 1, 'k.aif', kit)).rejects.toThrow(/track 5 takes synth samples.*nothing was written/)
    await expect(writeKit(root, 1, 1, 's.aif', synth)).rejects.toThrow(/track 1 takes drum kits.*nothing was written/)
    await expect(writeKit(root, 9, 1, 's.aif', synth)).rejects.toThrow(/no track 9/)
    expect((await inspect(root)).slots.every((s) => !s.files.length)).toBe(true)
  })
})
