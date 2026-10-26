import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeAiff, isAiff } from '../opz/aiff'
import { type Dir, type DiskReport, type SlotFile, type WriteResult, freeName, handleDir, inspect, readSlotFile, takenNames, writeKit } from '../opz/disk'
import { encodeDrumKit, kitSlices, readMeta } from '../opz/drumkit'
import { type Sound, frames, kitFrames, layOut, render, toSound } from '../opz/kit'
import {
  COMPUTER_KEYS, DRUM_TRACKS, KEYS, LOW_NOTE, MAX_FRAMES, SLOTS, SYNTH_FRAMES, SYNTH_TRACKS, TARGET,
  isDrumTrack, isSharp, keyNote, kitFileName, noteKey,
} from '../opz/layout'
import { DEFAULT_ROOT, NOTE_NAMES, detectPitch, encodeSynth, freqNote, noteFreq, noteName } from '../opz/synth'
import { envelope } from '../opz/wav'
import { decodeAny, play, stop, voice, wake } from './decode'
import { kitArt, keyTone } from './art'
import { listen, midiAvailable } from './midi'
import { Mark } from './Mark'
import { ThemeToggle } from './Theme'
import { Wallpaper } from './Wallpaper'

type Keys = (Sound | undefined)[]
/** A drum kit for tracks 1–4, or a synth sample for 5–8. */
type Mode = 'kit' | 'synth'
interface Target {
  track: number
  slot: number
}

const bar = 'label border border-rule bg-paper px-2.5 py-1 text-ink hover:border-orange disabled:opacity-40 disabled:hover:border-rule'
const primary = 'label border border-orange bg-orange px-2.5 py-1 font-medium text-white disabled:opacity-40'
const DRAG_KEY = 'application/x-zedgnome-key'
const emptyKeys = (): Keys => Array(KEYS).fill(undefined)
/** A synth sample is written padded to the full 6 s, plus header and settings. */
const SYNTH_BYTES = SYNTH_FRAMES * 2 + 600

/** Each kit sound rendered once, for MIDI to fire off without redoing it. */
const renders = new WeakMap<Sound, Float32Array>()
function rendered(s: Sound): Float32Array {
  let r = renders.get(s)
  if (!r) renders.set(s, (r = render(s)))
  return r
}

export function Board() {
  const [mode, setMode] = useState<Mode>('kit')
  const [keys, setKeys] = useState<Keys>(emptyKeys)
  const [synth, setSynth] = useState<Sound | undefined>()
  /** The pitch the synth sample is at, in Hz: the file's base_freq. */
  const [root, setRoot] = useState(DEFAULT_ROOT)
  const [names, setNames] = useState<Record<Mode, string>>({ kit: 'my kit', synth: 'my synth' })
  const [selected, setSelected] = useState(0)
  const [playing, setPlaying] = useState<number | 'kit' | undefined>()
  const [disk, setDisk] = useState<Dir | undefined>()
  const [report, setReport] = useState<DiskReport | undefined>()
  const [target, setTarget] = useState<Target | undefined>()
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<WriteResult | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  /** Notes sounding on the synth, by who started them (a MIDI note, a computer key), as key numbers. */
  const [held, setHeld] = useState<Record<string, number>>({})
  /** MIDI inputs once MIDI is on; undefined until then. */
  const [midi, setMidi] = useState<string[] | undefined>()
  const picker = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const isSynth = mode === 'synth'
  const name = names[mode]
  const setName = (v: string) => setNames((n) => ({ ...n, [mode]: v }))
  const synthAudio = useMemo(() => (synth ? render(synth) : undefined), [synth])
  const limit = isSynth ? SYNTH_FRAMES : MAX_FRAMES
  const used = isSynth ? (synth ? frames(synth) : 0) : kitFrames(keys)
  const over = used > limit
  const count = isSynth ? (synth ? 1 : 0) : keys.filter(Boolean).length
  const size = isSynth ? SYNTH_BYTES : kitSize(used)
  const thing = isSynth ? 'sample' : 'kit'
  const sel = keys[selected]
  const rootKey = Math.round(freqNote(root)) - LOW_NOTE
  const keyRate = (i: number) => noteFreq(LOW_NOTE + i) / root

  function update(i: number, s: Sound | undefined) {
    setKeys((ks) => ks.map((k, j) => (j === i ? s : k)))
    setResult(undefined)
  }

  function hear(i: number) {
    if (playing === i) return silence()
    if (isSynth) {
      if (!synthAudio) return
      play({ sampleRate: TARGET.sampleRate, channels: [synthAudio] }, () => setPlaying(undefined), keyRate(i))
    } else {
      const s = keys[i]
      if (!s) return
      play({ sampleRate: TARGET.sampleRate, channels: [render(s)] }, () => setPlaying(undefined))
    }
    setPlaying(i)
  }

  /** The whole kit end to end, or the synth sample at its own pitch. */
  function hearKit() {
    if (playing === 'kit') return silence()
    const audio = isSynth ? synthAudio : layOut(keys).audio
    if (!audio?.length) return
    play({ sampleRate: TARGET.sampleRate, channels: [audio] }, () => setPlaying(undefined))
    setPlaying('kit')
  }

  function silence() {
    stop()
    notes.current.clear()
    setHeld({})
    setPlaying(undefined)
  }

  /** Switch between kit and synth sample. A slot picked on the other kind of track is let go. */
  function enter(m: Mode) {
    if (m !== live.current.mode) silence()
    setMode(m)
    setResult(undefined)
    setTarget((t) => (t && isDrumTrack(t.track) !== (m === 'kit') ? undefined : t))
  }

  // Notes from MIDI and held computer keys. A kit plays each hit to its end; the synth holds until the note's off.
  const notes = useRef(new Map<string, () => void>())
  function noteOn(id: string, n: number) {
    const { mode, keys, synthAudio, root } = live.current
    const i = noteKey(n)
    if (mode === 'synth') {
      if (!synthAudio) return
      notes.current.get(id)?.()
      notes.current.set(id, voice(synthAudio, noteFreq(n) / root))
      setHeld((h) => ({ ...h, [id]: i }))
    } else {
      setSelected(i)
      const s = keys[i]
      if (s) voice(rendered(s))
    }
  }
  function noteOff(id: string) {
    notes.current.get(id)?.()
    notes.current.delete(id)
    setHeld((h) => {
      if (!(id in h)) return h
      const { [id]: _, ...rest } = h
      return rest
    })
  }

  async function startMidi() {
    wake()
    try {
      stopMidi.current?.()
      stopMidi.current = await listen((n, on) => (on ? notesRef.current.on(`midi:${n}`, n) : notesRef.current.off(`midi:${n}`)), setMidi)
    } catch (e) {
      setNote(`midi didn't start: ${(e as Error).message || 'not allowed'}. chrome asks once, and the answer sticks under site settings.`)
    }
  }
  const stopMidi = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => stopMidi.current?.(), [])
  const notesRef = useRef({ on: noteOn, off: noteOff })
  notesRef.current = { on: noteOn, off: noteOff }

  /** A sound in as the synth sample, cut to 6 s, with its root from the file or heard in it. */
  function takeSynth(s: Sound, given?: number): string {
    setSynth({ ...s, end: Math.min(s.source.length, SYNTH_FRAMES) })
    setNames((n) => ({ ...n, synth: s.name.toLowerCase().slice(0, 24) }))
    enter('synth')
    if (given && given > 20 && given < 20000) {
      setRoot(given)
      return ''
    }
    const hz = detectPitch(s.source)
    setRoot(hz ?? DEFAULT_ROOT)
    return hz ? `heard ${rootName(hz)} in it, so that is its root.` : 'no clear pitch in it, so its root is c4 — set it if the sound is a note.'
  }

  /** A synth sample off the OP-Z or an OP-1, root and all. */
  function loadSynth(bytes: Uint8Array, fileName: string): boolean {
    const meta = readMeta(bytes)
    if (meta?.type !== 'sampler') return false
    const base = (meta.name || fileName.replace(/\.aiff?$/i, '')).toLowerCase()
    takeSynth({ ...toSound('', decodeAiff(bytes)), name: base }, meta.base_freq)
    return true
  }

  /** A whole kit off the OP-Z or an OP-1: its slices become the keys. */
  function loadKit(bytes: Uint8Array, kitName: string): boolean {
    const meta = readMeta(bytes)
    if (meta?.type !== 'drum') return false
    const audio = decodeAiff(bytes)
    const mono = audio.channels[0]
    const slices = kitSlices(meta, mono.length)
    const base = (meta.name || kitName.replace(/\.aiff?$/i, '')).toLowerCase()
    setKeys(slices.map((span, i) => {
      if (!span) return undefined
      const source = mono.slice(span.start, span.end)
      return { name: `${base} ${i + 1}`, source, start: 0, end: source.length, pitch: 0, gain: 0, reverse: false }
    }))
    setNames((n) => ({ ...n, kit: base }))
    setSelected(Math.max(0, slices.findIndex(Boolean)))
    enter('kit')
    return true
  }

  async function addFiles(files: File[], from: number) {
    const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|m4a|ogg|flac)$/i.test(f.name))
    if (!audio.length) return setNote('those are not sounds — try wav, aiff or mp3.')
    setBusy('reading')
    setNote(undefined)
    try {
      if (audio.length === 1 || isSynth) {
        const f = audio[0]
        const bytes = new Uint8Array(await f.arrayBuffer())
        if (isAiff(bytes) && loadKit(bytes, f.name)) return setNote(`${f.name} is a drum kit — its slices are on the keys now.`)
        if (isAiff(bytes) && loadSynth(bytes, f.name)) return setNote(`${f.name} is a synth sample — it is on the synth now, with its root.`)
        if (isSynth) {
          let s: Sound
          try {
            s = toSound(f.name, await decodeAny(bytes))
          } catch {
            return setNote(`could not read ${f.name}.`)
          }
          const said = takeSynth(s)
          return setNote([said, audio.length > 1 ? 'a synth sample is one sound, so only the first file was used.' : ''].filter(Boolean).join(' '))
        }
      }
      const placed: Sound[] = []
      const failed: string[] = []
      for (const f of audio.slice(0, KEYS - from)) {
        try {
          placed.push(toSound(f.name, await decodeAny(new Uint8Array(await f.arrayBuffer()))))
        } catch {
          failed.push(f.name)
        }
      }
      setKeys((ks) => ks.map((k, i) => (i >= from && i < from + placed.length ? placed[i - from] : k)))
      setResult(undefined)
      const dropped = audio.length - Math.min(audio.length, KEYS - from)
      setNote([
        failed.length ? `could not read ${failed.join(', ')}.` : '',
        dropped ? `${dropped} more than the keys left — start further down to fit them.` : '',
      ].filter(Boolean).join(' ') || undefined)
    } finally {
      setBusy(undefined)
    }
  }

  function moveKey(from: number, to: number) {
    if (from === to) return
    setKeys((ks) => ks.map((k, i) => (i === from ? ks[to] : i === to ? ks[from] : k)))
    setSelected(to)
  }

  async function openDisk() {
    try {
      const handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> })
        .showDirectoryPicker({ mode: 'readwrite' })
      const d = handleDir(handle)
      setBusy('reading the op-z')
      const r = await inspect(d)
      setDisk(d)
      setReport(r)
      setResult(undefined)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setNote((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  async function openSlot(track: number, slot: number, file: string) {
    if (!disk) return
    setBusy(`reading ${file}`)
    try {
      const bytes = await readSlotFile(disk, track, slot, file)
      if (!bytes) return setNote(`could not read ${file}.`)
      if (loadKit(bytes, file) || loadSynth(bytes, file)) {
        setNote(`opened ${file} from track ${track}, slot ${slot}.`)
      } else if (isDrumTrack(track)) {
        // No settings in it: a plain sound. Put it on one key.
        update(selected, toSound(file, decodeAiff(bytes)))
        enter('kit')
        setNote(`${file} has no drum kit in it, so it went on key ${selected + 1} as one sound.`)
      } else {
        setNote(`${file} has no synth settings in it. ${takeSynth(toSound(file, decodeAiff(bytes)))}`)
      }
      setTarget({ track, slot })
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  function kitBytes() {
    if (isSynth) return encodeSynth(name.trim() || 'synth', synthAudio ?? new Float32Array(0), root)
    return encodeDrumKit(name.trim() || 'kit', layOut(keys))
  }

  function detect() {
    const hz = synthAudio && detectPitch(synthAudio)
    if (hz) setRoot(hz)
    setNote(hz ? `heard ${rootName(hz)}.` : 'no clear pitch in it — set the root by hand.')
  }

  function download() {
    save(kitBytes(), kitFileName(name))
  }

  async function write() {
    if (!disk || !target) return
    setConfirming(false)
    silence()
    setBusy('writing')
    try {
      const res = await writeKit(disk, target.track, target.slot, kitFileName(name), kitBytes())
      setResult(res)
      setReport(await inspect(disk))
      setNote(undefined)
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  // Keyboard: the tracker layout plays keys; space, esc, arrows and delete work the selection.
  const live = useRef({ keys, selected, playing, mode, synthAudio, root })
  live.current = { keys, selected, playing, mode, synthAudio, root }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || confirming) return
      if (t.closest('input, select, textarea, [contenteditable]')) return
      const k = e.key.toLowerCase()
      const i = COMPUTER_KEYS.indexOf(k)
      if (i >= 0 && !e.repeat && live.current.mode === 'synth') {
        setSelected(i)
        notesRef.current.on(`key:${k}`, LOW_NOTE + i)
        return
      }
      if (i >= 0 && !e.repeat) {
        setSelected(i)
        const s = live.current.keys[i]
        if (s) {
          play({ sampleRate: TARGET.sampleRate, channels: [render(s)] }, () => setPlaying(undefined))
          setPlaying(i)
        }
        return
      }
      if (t.closest('button, a')) return
      if (k === ' ') {
        e.preventDefault()
        hearRef.current(live.current.selected)
      } else if (k === 'escape') silence()
      else if (k === 'arrowright') setSelected((s) => Math.min(KEYS - 1, s + 1))
      else if (k === 'arrowleft') setSelected((s) => Math.max(0, s - 1))
      else if (k === 'arrowup') setSelected((s) => Math.min(KEYS - 1, s + 12))
      else if (k === 'arrowdown') setSelected((s) => Math.max(0, s - 12))
      else if ((k === 'delete' || k === 'backspace') && live.current.mode === 'kit') update(live.current.selected, undefined)
      else return
      e.preventDefault()
    }
    // A held synth note lets go with its key, or when the page loses the keyboard.
    const onUp = (e: KeyboardEvent) => notesRef.current.off(`key:${e.key.toLowerCase()}`)
    const onBlur = () => COMPUTER_KEYS.forEach((k) => notesRef.current.off(`key:${k}`))
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [confirming])
  const hearRef = useRef(hear)
  hearRef.current = hear

  const art = useMemo(() => {
    const shown = isSynth ? (synth ? [{ ...synth, name }] : []) : keys
    return kitArt(name, shown.map((s) => (s ? { name: s.name, tone: keyTone(s) } : undefined)))
  }, [name, keys, synth, isSynth])
  const tracks = isSynth ? SYNTH_TRACKS : DRUM_TRACKS
  const heldKeys = new Set(Object.values(held))
  const rootMidi = Math.round(freqNote(root))
  const targetSlot = target && report?.slots.find((s) => s.track === target.track && s.slot === target.slot)
  const yours = report?.slots.filter((s) => s.files.length).length ?? 0
  const writeName = report && target ? freeName(takenNames(report, target.track, target.slot), kitFileName(name)) : kitFileName(name)
  const canWrite = !!disk && !!report?.ok && !!target && !targetSlot?.hidden && count > 0 && !over && !busy
    && isDrumTrack(target.track) === !isSynth && !!report.tracks.find((t) => t.n === target.track)?.folder

  return (
    <div className="bench min-h-dvh">
      <Wallpaper art={art} />
      <header className="z-20 flex sm:sticky sm:top-0 flex-wrap items-center justify-between gap-3 border-b border-rule bg-paper px-4 py-[9px]">
        <h1 className="m-0 flex items-center gap-[9px] text-[14px] font-semibold tracking-tight">
          <span className="brand-mark"><Mark framed /></span>
          <span>zed <span className="wordmark text-orange">gnome</span></span>
        </h1>
        <nav className="label flex flex-wrap items-center gap-x-4 gap-y-1 whitespace-nowrap" aria-label="site">
          <ThemeToggle />
          <a href="https://micgnome.stephen8n.com" target="_blank" rel="noreferrer noopener" className="underline hover:text-orange"
            title="Mic Gnome: patch bay for the TE EP-2350 mic">mic gnome</a>
          <a href="https://padgnome.stephen8n.com" target="_blank" rel="noreferrer noopener" className="underline hover:text-orange"
            title="Pad Gnome: put samples on the pads of an SP-404SX">pad gnome</a>
          <a href="https://subgnome.stephen8n.com" target="_blank" rel="noreferrer noopener" className="underline hover:text-orange"
            title="Sub Gnome: a sub-bass synth with everything that moves it">sub gnome</a>
          <a href="https://tdmdne.stephen8n.com" target="_blank" rel="noreferrer noopener" className="underline hover:text-orange"
            title="Drum Gnome: this drum machine does not exist, a new kit every click">drum gnome</a>
          <a href="https://riffbook.stephen8n.com" target="_blank" rel="noreferrer noopener" className="underline hover:text-orange"
            title="Riff Gnome: Stephen's music-idea sketchbook (private)">riff gnome</a>
          <a href="https://stephen8n.com" target="_blank" rel="noreferrer noopener" className="underline hover:text-orange"
            title="more from Stephen Cummins">stephen8n</a>
        </nav>
      </header>

      <div className="mx-auto flex max-w-[1120px] flex-col gap-4 px-4 pt-5 pb-8">
        <section className="device border border-rule bg-paper" aria-label="the kit">
          {/* The device's own bar: the disk, and what acts on it. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-rule bg-panel px-3.5 py-2.5">
            <div className="label flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span>op-z</span>
              <span aria-hidden>·</span>
              {disk && report?.ok ? (
                <span>disk <b className="font-medium text-ink">{disk.name || 'open'}</b> · {yours} of yours on it</span>
              ) : (
                <span>no disk open</span>
              )}
              <span aria-hidden>·</span>
              {isSynth
                ? <span>{synth ? 'one sample' : 'no sample yet'} · {kb(size)}</span>
                : <span><b className="font-medium text-ink">{count}</b> of 24 keys · {kb(size)}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {picker ? (
                <button type="button" className={bar} onClick={() => void openDisk()}
                  title="switch the op-z on in content mode, then pick the disk it mounts">
                  {disk ? 'reopen op-z' : 'open op-z'}
                </button>
              ) : (
                <span className="label" title="writing straight to the op-z needs the File System Access API">chrome or edge to write the op-z</span>
              )}
              <button type="button" className={bar} disabled={!count || over} onClick={download}
                title={`the ${thing} as an .aif — drop it in a slot folder on the op-z yourself`}>
                download .aif
              </button>
              <button type="button" disabled={!canWrite} onClick={() => setConfirming(true)} className={primary}
                title={report?.ok && !target ? 'pick a slot in the grid below first' : undefined}>
                write to op-z
              </button>
            </div>
          </div>

          {report && !report.ok && (
            <p className="data m-0 border-b border-rule bg-orange-soft px-3.5 py-2 text-ink">{report.problem}</p>
          )}
          {report?.ok && report.rejected.length > 0 && (
            <p className="label m-0 border-b border-rule px-3.5 py-2">
              the op-z rejected these last time: {report.rejected.join(', ')}
            </p>
          )}

          {/* What is being made, its name, and the time it may take */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-3.5 py-2.5">
            <div className="flex" role="group" aria-label="what to make">
              {(['kit', 'synth'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => enter(m)}
                  title={m === 'kit' ? 'a drum kit for tracks 1–4: a sound on each key' : 'a synth sample for tracks 5–8: one sound, played at every key\'s pitch'}
                  className={`label border px-2.5 py-1 ${m === 'synth' ? '-ml-px' : ''} ${mode === m ? 'relative border-orange bg-orange-soft text-ink' : 'border-rule bg-paper hover:text-ink'}`}>
                  {m === 'kit' ? 'drum kit' : 'synth sample'}
                </button>
              ))}
            </div>
            <label className="label flex items-center gap-2">
              name
              <input value={name} maxLength={24} onChange={(e) => { setName(e.target.value); setResult(undefined) }}
                className="data w-40 border border-rule bg-paper px-1.5 py-0.5 text-ink" aria-label={`${thing} name`} />
            </label>
            <Budget parts={isSynth ? (synth ? [{ title: synth.name, frames: used }] : [])
              : keys.flatMap((s, i) => (s ? [{ title: `key ${i + 1}: ${s.name}`, frames: frames(s) }] : []))}
              used={used} max={limit} />
            <button type="button" className={bar} disabled={!count} onClick={hearKit}
              title={isSynth ? `the sample as it is, at its root (${rootName(root)})` : 'every key in turn'}>
              {playing === 'kit' ? 'stop' : isSynth ? 'play sample' : 'play kit'}
            </button>
            {midiAvailable() && (midi ? (
              <span className="label" title="notes from any midi input play the keys">
                midi in: <span className="text-ink">{midi.length ? midi.join(', ') : 'nothing plugged in'}</span>
              </span>
            ) : (
              <button type="button" className={bar} onClick={() => void startMidi()}
                title="play the keys from a midi keyboard, or from the op-z itself in normal mode over usb">
                midi in
              </button>
            ))}
          </div>

          <div className="grid gap-0 md:grid-cols-[1fr_300px]">
            {/* Two octaves, high above low, as on a keyboard seen from the player */}
            <div className="flex flex-col gap-2.5 p-3.5 md:border-r md:border-rule">
              {[12, 0].map((row) => (
                <div key={row} className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
                  {Array.from({ length: 12 }, (_, j) => {
                    const i = row + j
                    return (
                      <Key key={i} i={i} sound={isSynth ? undefined : keys[i]} selected={selected === i}
                        playing={playing === i || heldKeys.has(i)}
                        lit={isSynth ? !!synth && (i === rootKey || heldKeys.has(i)) : undefined}
                        tag={isSynth && synth ? (i === rootKey ? 'root' : noteName(LOW_NOTE + i)) : undefined}
                        onSelect={() => setSelected(i)}
                        onPlay={() => { setSelected(i); hear(i) }}
                        onDropFiles={(files) => void addFiles(files, i)}
                        onDropKey={(from) => moveKey(from, i)} />
                    )
                  })}
                </div>
              ))}
              <p className="label m-0">
                keys 1–12 on the bottom row, 13–24 on top · play them from the computer: z to m for the low octave, q to u for the high
                {isSynth && <>
                  {' '}· hold keys for chords. key 1 is taken as f3 and key 8 as middle c, which is how the op-z's octave 0 is
                  expected to sit — not yet checked on one.
                </>}
              </p>
            </div>

            {/* The selected key */}
            <aside className="flex flex-col gap-4 border-t border-rule p-3.5 md:border-t-0">
              {isSynth ? (
                <SynthPanel synth={synth} root={root} rootMidi={rootMidi} playing={playing} selected={selected}
                  set={(s) => { setSynth(s); setResult(undefined) }}
                  setRoot={(hz) => { setRoot(hz); setResult(undefined) }}
                  detect={detect} hear={hear} silence={silence}
                  clear={() => { setSynth(undefined); setResult(undefined) }}
                  choose={(files) => void addFiles(files, selected)} />
              ) : (<>
              <div>
                <p className="label m-0">key {selected + 1} · {keyNote(selected)} · plays on <span className="text-ink">{COMPUTER_KEYS[selected]}</span></p>
                {sel ? (
                  <>
                    <p className="data m-0 mt-1 break-all text-ink">{sel.name}</p>
                    <p className="label m-0">{secs(frames(sel))} in the kit · {secs(sel.source.length)} as it came</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" className={bar} onClick={() => hear(selected)}>{playing === selected ? 'stop' : 'play'}</button>
                      <button type="button" className={bar} onClick={() => update(selected, undefined)}>clear key</button>
                    </div>
                    <Shape sound={sel} />
                    <div className="mt-2 flex flex-col gap-2">
                      <Slider label="start" value={sel.start} min={0} max={sel.source.length} step={1}
                        show={secs(sel.start)} set={(v) => update(selected, { ...sel, start: Math.min(v, sel.end - 64) })} />
                      <Slider label="end" value={sel.end} min={0} max={sel.source.length} step={1}
                        show={secs(sel.end)} set={(v) => update(selected, { ...sel, end: Math.max(v, sel.start + 64) })} />
                      <Slider label="pitch" value={sel.pitch} min={-12} max={12} step={1}
                        show={`${sel.pitch > 0 ? '+' : ''}${sel.pitch} st`} set={(v) => update(selected, { ...sel, pitch: v })} />
                      <Slider label="gain" value={sel.gain} min={-24} max={12} step={0.5}
                        show={`${sel.gain > 0 ? '+' : ''}${sel.gain} db`} set={(v) => update(selected, { ...sel, gain: v })} />
                      <Check label="reversed" on={sel.reverse} set={(v) => update(selected, { ...sel, reverse: v })} />
                      <button type="button" className={`${bar} self-start`}
                        onClick={() => update(selected, { ...sel, start: 0, end: sel.source.length, pitch: 0, gain: 0, reverse: false })}>
                        reset
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="label m-0 mt-1">empty. drop a sound on it, or choose one:</p>
                )}
                {playing !== undefined && playing !== selected && (
                  <p className="label m-0 mt-2 flex items-center gap-2">
                    <span className="text-orange">{playing === 'kit' ? 'the kit' : `key ${playing + 1}`} is playing</span>
                    <button type="button" className={bar} onClick={silence}>stop</button>
                  </p>
                )}
                <label className={`${bar} mt-3 inline-block cursor-pointer`}>
                  choose files…
                  <input type="file" multiple accept="audio/*,.wav,.aif,.aiff,.mp3" className="sr-only"
                    onChange={(e) => { void addFiles([...(e.target.files ?? [])], selected); e.target.value = '' }} />
                </label>
                <p className="label m-0 mt-1">several files fill keys from this one. a drum kit .aif opens as a whole kit.</p>
              </div>
              <p className="label m-0 border-t border-rule pt-3">
                drag key to key to swap · space plays and stops · esc stops · arrows move · delete clears ·
                pitch, gain and reverse are baked into the sound, so the op-z plays exactly what you hear
              </p>
              </>)}
            </aside>
          </div>

          {(busy || note) && (
            <p className="label m-0 border-t border-rule bg-panel px-3.5 py-2 text-ink" role="status">{busy ? `${busy}…` : note}</p>
          )}
        </section>

        {disk && report?.ok && (
          <section className="border border-rule bg-paper" aria-label={`the op-z's ${isSynth ? 'synth' : 'drum'} slots`}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-panel px-3.5 py-2.5">
              <span className="label">{isSynth ? 'synth' : 'drum'} slots on the op-z · pick where the {thing} goes, or open one to edit it</span>
              <span className="label">
                {target ? <>writing to <b className="font-medium text-ink">track {target.track}, slot {target.slot}</b></> : <b className="font-medium text-orange">pick a slot for the {thing}</b>}
              </span>
            </div>
            <div className="overflow-x-auto p-3.5">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="label w-20 p-1 text-left font-normal">track</th>
                    {Array.from({ length: SLOTS }, (_, s) => <th key={s} className="label p-1 font-normal">{s + 1}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {tracks.map((t) => {
                    const folder = report.tracks.find((x) => x.n === t.n)?.folder
                    return (
                      <tr key={t.n}>
                        <td className="label p-1">{t.n} {t.name}</td>
                        {Array.from({ length: SLOTS }, (_, j) => {
                          const s = report.slots.find((x) => x.track === t.n && x.slot === j + 1)!
                          const on = target?.track === t.n && target.slot === j + 1
                          const file = s.files[0]
                          return (
                            <td key={j} className="p-0.5">
                              <button type="button" disabled={!folder} onClick={() => setTarget({ track: t.n, slot: j + 1 })}
                                onDoubleClick={() => file && void openSlot(t.n, j + 1, file.name)}
                                title={file ? `${describe(file)} — double-click to open it` : s.hidden ? (isSynth ? 'in use: one of the op-z\'s own synths, or a sample another slot also plays' : 'in use: a factory kit, or a kit another slot also plays') : 'empty'}
                                className={`data h-9 w-full min-w-14 truncate border px-1 text-[11px] disabled:opacity-30
                                  ${on ? 'border-orange bg-orange-soft text-ink' : s.hidden ? 'border-rule-soft bg-paper text-mute' : file ? 'border-rule bg-panel text-ink' : 'border-dashed border-rule-soft text-mute'}`}>
                                {file ? shortName(file) : s.hidden ? 'in use' : '·'}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {target && targetSlot?.files[0] && (
                <p className="label m-0 mt-2 flex flex-wrap items-center gap-2">
                  this slot holds {targetSlot.files.map(describe).join('; ')} — writing replaces it.
                  {targetSlot.files.map((f) => (
                    <button key={f.name} type="button" className={bar} onClick={() => void openSlot(target.track, target.slot, f.name)}>
                      open {f.name} here
                    </button>
                  ))}
                </p>
              )}
              {targetSlot?.hidden && (
                <p className="label m-0 mt-2 text-orange">
                  this slot is in use, so zed gnome won't write here. pick another, or if you don't need what is in it, delete the ~
                  file in samplepacks/{report.tracks.find((x) => x.n === targetSlot.track)?.folder}/{targetSlot.folder} in finder
                  and open the op-z here again.
                </p>
              )}
              {isSynth ? (
                <p className="label m-0 mt-2">
                  "in use" cells hold a 0-byte ~ file. on a synth track that is mostly ~NN.engine, which puts one of the op-z's own
                  synth engines in the slot, so most synth slots start out in use. a slot only takes a sample once its ~ file is
                  deleted in finder, and that takes the engine off the slot — zed gnome hasn't found out how to put one back.
                  chrome won't show or touch those files, so zed gnome finds them by trying to delete each slot folder that looks
                  empty: that only works when nothing is in it, and the folder is made again straight away.
                </p>
              ) : (
                <p className="label m-0 mt-2">
                  "in use" cells hold a 0-byte ~name file, which is how the op-z marks a factory kit, or a kit another slot also
                  plays. chrome won't show or touch those files, so zed gnome finds them by trying to delete each slot folder that
                  looks empty: that only works when nothing is in it, and the folder is made again straight away. your own kits
                  stay on the disk as full .aif files.
                </p>
              )}
              {report.importLog.length > 0 && (
                <details className="mt-3 border-t border-rule pt-2">
                  <summary className="label cursor-pointer">
                    last import on the op-z{importVerdict(report.importLog)}
                  </summary>
                  <pre className="data m-0 mt-2 overflow-x-auto bg-panel p-2 text-[11px] leading-relaxed text-ink">
                    {report.importLog.map((l) => (/fail|can't|full|reject/i.test(l) ? `! ${l}` : `  ${l}`)).join('\n')}
                  </pre>
                </details>
              )}
            </div>
          </section>
        )}

        {result && (
          <section className="border border-pass bg-pass-soft px-3.5 py-3" aria-label="written">
            <p className="data m-0 text-pass">written to the op-z ✓</p>
            <p className="label m-0 mt-1 text-ink">
              {result.path}{result.madeSlot ? ' (the slot folder was missing, so zed gnome made it)' : ''}
              {result.written !== kitFileName(name) ? ` — named ${result.written} because another slot already uses ${kitFileName(name)}, and the op-z drops both when a name appears twice` : ''}.
              eject the op-z properly: it imports the {thing} as it leaves content mode, and the .aif stays on the disk. open the
              op-z here again afterwards and zed gnome shows what its import log said.
            </p>
            {result.replaced.length > 0 && (
              <p className="label m-0 mt-2 flex flex-wrap items-center gap-2 text-ink">
                replaced {result.replaced.map((r) => r.name).join(', ')}. the op-z has no room for backups, so what was there is
                only in this page:
                {result.replaced.map((r) => (
                  <button key={r.name} type="button" className={bar} onClick={() => save(r.data, r.name)}>save {r.name}</button>
                ))}
              </p>
            )}
          </section>
        )}
      </div>

      {confirming && disk && target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal aria-label="write to op-z">
          <div className="w-full max-w-md border border-rule bg-paper p-4">
            <p className="data m-0 font-medium">write {writeName} to track {target.track}, slot {target.slot}?</p>
            <p className="label m-0 mt-2">
              {isSynth
                ? <>{secs(used)} of sound, padded with silence to 6 s · root {rootName(root)} · {kb(size)}.</>
                : <>{count} key{count === 1 ? '' : 's'} · {secs(used)} of 12 s · {kb(size)}.</>}
              {writeName !== kitFileName(name) && ` another slot already uses ${kitFileName(name)}, so it goes in as ${writeName}.`}
              {!targetSlot?.files.length && ' the slot is empty.'}
            </p>
            {targetSlot?.files.map((f) => (
              <p key={f.name} className="label m-0 mt-1">
                replaces {f.name}, which is read into this page first so you can save it afterwards.
              </p>
            ))}
            <div className="mt-3 flex justify-end gap-1.5">
              <button type="button" className={bar} onClick={() => setConfirming(false)}>cancel</button>
              <button type="button" onClick={() => void write()} className={primary}>write</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Key(props: {
  i: number
  sound?: Sound
  selected: boolean
  playing: boolean
  /** Drawn as holding a sound; a kit key does when it has one. */
  lit?: boolean
  /** The line at the foot of the key, in place of the sound's name. */
  tag?: string
  onSelect: () => void
  onPlay: () => void
  onDropFiles: (files: File[]) => void
  onDropKey: (from: number) => void
}) {
  const { i, sound, selected, playing } = props
  const [over, setOver] = useState(false)
  const shape = useMemo(() => (sound ? envelope({ sampleRate: TARGET.sampleRate, channels: [render(sound)] }, 20) : undefined), [sound])
  const sharp = isSharp(i)
  const lit = props.lit ?? !!sound
  const tag = props.tag ?? sound?.name ?? ''

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`key ${i + 1}${tag ? `: ${tag}` : ', empty'}${playing ? ', playing' : ''}`}
      draggable={!!sound}
      onDragStart={(e) => e.dataTransfer.setData(DRAG_KEY, String(i))}
      onClick={props.onSelect}
      onDoubleClick={props.onPlay}
      onDragOver={(e) => { e.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const from = e.dataTransfer.getData(DRAG_KEY)
        if (from) props.onDropKey(Number(from))
        else if (e.dataTransfer.files.length) props.onDropFiles([...e.dataTransfer.files])
      }}
      className={`relative flex aspect-[3/4] min-w-0 cursor-pointer flex-col justify-between border-2 p-1.5 text-left
        ${lit ? 'border-orange bg-orange-soft' : sharp ? 'border-rule bg-panel' : 'border-rule bg-paper'}
        ${selected ? 'outline-2 outline-offset-2 outline-orange' : ''} ${over ? 'border-dashed border-orange' : ''}`}
    >
      <span className="label flex items-center justify-between">
        <span className="text-ink">{i + 1}</span>
        <span className={playing ? 'text-orange' : ''}>{playing ? '▶' : keyNote(i)}</span>
      </span>
      {shape && (
        <svg viewBox="0 0 20 10" preserveAspectRatio="none" className="h-1/4 w-full" aria-hidden>
          {shape.map((v, x) => (
            <rect key={x} x={x + 0.15} width={0.7} y={5 - Math.max(0.2, v * 5)} height={Math.max(0.4, v * 10)} fill="var(--color-orange)" />
          ))}
        </svg>
      )}
      <span className="data truncate text-[10.5px] text-ink" title={tag}>{tag}</span>
    </div>
  )
}

/** The trim drawn over the whole sound, so start and end have something to sit on. */
function Shape({ sound }: { sound: Sound }) {
  const shape = useMemo(() => envelope({ sampleRate: TARGET.sampleRate, channels: [sound.source] }, 60), [sound.source])
  const n = sound.source.length || 1
  const a = (sound.start / n) * 60
  const b = (sound.end / n) * 60
  return (
    <svg viewBox="0 0 60 12" preserveAspectRatio="none" className="mt-2 h-12 w-full border border-rule bg-panel" aria-hidden>
      {shape.map((v, x) => (
        <rect key={x} x={x + 0.15} width={0.7} y={6 - Math.max(0.15, v * 6)} height={Math.max(0.3, v * 12)}
          fill={x >= a && x < b ? 'var(--color-orange)' : 'var(--color-rule)'} />
      ))}
    </svg>
  )
}

/** The time allowed as a strip, each sound's share in turn, so it is plain which sound is eating the budget. */
function Budget({ parts, used, max }: { parts: { title: string; frames: number }[]; used: number; max: number }) {
  const over = used > max
  const limit = max / TARGET.sampleRate
  return (
    <div className="flex min-w-[220px] flex-1 items-center gap-2">
      <div className="relative flex h-3 flex-1 overflow-hidden border border-rule bg-panel" role="meter" aria-label="length"
        aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Number((used / TARGET.sampleRate).toFixed(2))}>
        {parts.map((p, i) => (
          <span key={i} title={`${p.title}, ${secs(p.frames)}`} style={{ width: `${(p.frames / Math.max(used, max)) * 100}%` }}
            className={`h-full border-r border-paper ${i % 2 ? 'bg-ink/45' : 'bg-ink/70'}`} />
        ))}
        {over && <span className="absolute top-0 bottom-0 border-l-2 border-orange" style={{ left: `${(max / used) * 100}%` }} />}
      </div>
      <span className={`data whitespace-nowrap text-[12px] ${over ? 'text-orange' : 'text-ink'}`}>
        {secs(used)} / {limit} s{over ? ' — too long' : ''}
      </span>
    </div>
  )
}

/** The synth sample: its trim, its level, and the note it is at. */
function SynthPanel(props: {
  synth?: Sound
  root: number
  rootMidi: number
  playing: number | 'kit' | undefined
  selected: number
  set: (s: Sound) => void
  setRoot: (hz: number) => void
  detect: () => void
  hear: (i: number) => void
  silence: () => void
  clear: () => void
  choose: (files: File[]) => void
}) {
  const { synth: s, root, rootMidi, playing, selected, set } = props
  const pitchClass = ((rootMidi % 12) + 12) % 12
  const octave = Math.floor(rootMidi / 12) - 1
  return (
    <>
      <div>
        <p className="label m-0">synth sample · one sound, played at each key's pitch</p>
        {s ? (
          <>
            <p className="data m-0 mt-1 break-all text-ink">{s.name}</p>
            <p className="label m-0">{secs(frames(s))} of 6 s · {secs(s.source.length)} as it came</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" className={bar} onClick={() => props.hear(selected)}>
                {playing === selected ? 'stop' : `play key ${selected + 1}`}
              </button>
              <button type="button" className={bar} onClick={props.clear}>clear</button>
            </div>
            <Shape sound={s} />
            <div className="mt-2 flex flex-col gap-2">
              <Slider label="start" value={s.start} min={0} max={s.source.length} step={1}
                show={secs(s.start)} set={(v) => set({ ...s, start: Math.min(v, s.end - 64) })} />
              <Slider label="end" value={s.end} min={0} max={s.source.length} step={1}
                show={secs(s.end)} set={(v) => set({ ...s, end: Math.max(v, s.start + 64) })} />
              <Slider label="gain" value={s.gain} min={-24} max={12} step={0.5}
                show={`${s.gain > 0 ? '+' : ''}${s.gain} db`} set={(v) => set({ ...s, gain: v })} />
              <Check label="reversed" on={s.reverse} set={(v) => set({ ...s, reverse: v })} />
              <button type="button" className={`${bar} self-start`}
                onClick={() => set({ ...s, start: 0, end: Math.min(s.source.length, SYNTH_FRAMES), gain: 0, reverse: false })}>
                reset
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-rule pt-3">
              <span className="label">root</span>
              <select className="data border border-rule bg-paper px-1 py-0.5 text-ink" aria-label="root note" value={pitchClass}
                onChange={(e) => props.setRoot(noteFreq((octave + 1) * 12 + Number(e.target.value)))}>
                {NOTE_NAMES.map((n, i) => <option key={n} value={i}>{n}</option>)}
              </select>
              <select className="data border border-rule bg-paper px-1 py-0.5 text-ink" aria-label="root octave" value={octave}
                onChange={(e) => props.setRoot(noteFreq((Number(e.target.value) + 1) * 12 + pitchClass))}>
                {Array.from({ length: 8 }, (_, o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button type="button" className={bar} onClick={props.detect} title="listen for the note the sound is at">detect</button>
              <span className="label">{rootName(root)} · {root.toFixed(1)} hz</span>
            </div>
            <p className="label m-0 mt-1">
              the note the sound is at. the op-z plays it back from here, so a sound with the wrong root plays out of tune
              with the other tracks.
            </p>
          </>
        ) : (
          <p className="label m-0 mt-1">empty. drop a sound on any key, or choose one:</p>
        )}
        {playing !== undefined && playing !== selected && (
          <p className="label m-0 mt-2 flex items-center gap-2">
            <span className="text-orange">{playing === 'kit' ? 'the sample' : `key ${playing + 1}`} is playing</span>
            <button type="button" className={bar} onClick={props.silence}>stop</button>
          </p>
        )}
        <label className={`${bar} mt-3 inline-block cursor-pointer`}>
          choose a file…
          <input type="file" accept="audio/*,.wav,.aif,.aiff,.mp3" className="sr-only"
            onChange={(e) => { props.choose([...(e.target.files ?? [])]); e.target.value = '' }} />
        </label>
        <p className="label m-0 mt-1">up to 6 s. a synth sample .aif opens with its root. it is written padded with silence to 6 s, as the op-z expects.</p>
      </div>
      <p className="label m-0 border-t border-rule pt-3">
        space plays the picked key · esc stops · arrows move · hold computer keys or midi notes for chords · trim, gain and
        reverse are baked into the sound
      </p>
    </>
  )
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; show: string; set: (v: number) => void }) {
  return (
    <label className="grid grid-cols-[44px_1fr_64px] items-center gap-2">
      <span className="label">{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value}
        onChange={(e) => props.set(Number(e.target.value))} className="w-full accent-[var(--color-orange)]" />
      <span className="data text-right text-[12px] text-ink">{props.show}</span>
    </label>
  )
}

function Check({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="data flex cursor-pointer items-center gap-2 text-ink">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} className="accent-[var(--color-orange)]" />
      {label}
    </label>
  )
}

function save(data: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/aiff' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** One kit in a slot, as a person would say it. */
const describe = (f: SlotFile) => `${f.name}, ${kb(f.bytes)}`
const shortName = (f: SlotFile) => f.name.replace(/\.aiff?$/i, '')

/** A word on the import log's last run, for its summary line. */
function importVerdict(lines: string[]): string {
  const bad = lines.filter((l) => /fail|can't|full/i.test(l)).length
  const good = lines.filter((l) => /importing .*success/i.test(l)).length
  if (bad) return ` · ${bad} problem${bad === 1 ? '' : 's'}`
  if (good) return ` · ${good} kit${good === 1 ? '' : 's'} imported`
  return ''
}

const secs = (n: number) => `${(n / TARGET.sampleRate).toFixed(2)} s`
/** A pitch as a note and how far off it is: 220 → "a3", 224 → "a3 +31 cents". */
function rootName(hz: number) {
  const n = freqNote(hz)
  const cents = Math.round((n - Math.round(n)) * 100)
  return `${noteName(Math.round(n))}${cents ? ` ${cents > 0 ? '+' : ''}${cents} cents` : ''}`
}
/** The written file: 16-bit mono plus about 1.5 kb of header and settings. */
const kitSize = (n: number) => Math.min(n, MAX_FRAMES) * 2 + 1600
const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kb` : `${(bytes / 1024 / 1024).toFixed(1)} mb`)
