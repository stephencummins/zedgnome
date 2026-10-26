import { useEffect, useMemo, useRef, useState } from 'react'
import { decodeAiff, isAiff } from '../opz/aiff'
import { type Dir, type DiskReport, type SlotFile, type WriteResult, freeName, handleDir, inspect, readSlotFile, takenNames, writeKit } from '../opz/disk'
import { encodeDrumKit, kitSlices, readMeta } from '../opz/drumkit'
import { type Sound, frames, kitFrames, layOut, render, toSound } from '../opz/kit'
import { COMPUTER_KEYS, DRUM_TRACKS, KEYS, MAX_FRAMES, SLOTS, TARGET, isSharp, keyNote, kitFileName } from '../opz/layout'
import { envelope } from '../opz/wav'
import { decodeAny, play, stop } from './decode'
import { kitArt, keyTone } from './art'
import { Mark } from './Mark'
import { ThemeToggle } from './Theme'
import { Wallpaper } from './Wallpaper'

type Keys = (Sound | undefined)[]
interface Target {
  track: number
  slot: number
}

const bar = 'label border border-rule bg-paper px-2.5 py-1 text-ink hover:border-orange disabled:opacity-40 disabled:hover:border-rule'
const primary = 'label border border-orange bg-orange px-2.5 py-1 font-medium text-white disabled:opacity-40'
const DRAG_KEY = 'application/x-zedgnome-key'
const emptyKeys = (): Keys => Array(KEYS).fill(undefined)

export function Board() {
  const [keys, setKeys] = useState<Keys>(emptyKeys)
  const [name, setName] = useState('my kit')
  const [selected, setSelected] = useState(0)
  const [playing, setPlaying] = useState<number | 'kit' | undefined>()
  const [disk, setDisk] = useState<Dir | undefined>()
  const [report, setReport] = useState<DiskReport | undefined>()
  const [target, setTarget] = useState<Target>({ track: 1, slot: 1 })
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<WriteResult | undefined>()
  const [busy, setBusy] = useState<string | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const picker = typeof window !== 'undefined' && 'showDirectoryPicker' in window

  const used = kitFrames(keys)
  const over = used > MAX_FRAMES
  const count = keys.filter(Boolean).length
  const sel = keys[selected]

  function update(i: number, s: Sound | undefined) {
    setKeys((ks) => ks.map((k, j) => (j === i ? s : k)))
    setResult(undefined)
  }

  function hear(i: number) {
    const s = keys[i]
    if (!s) return
    if (playing === i) return silence()
    play({ sampleRate: TARGET.sampleRate, channels: [render(s)] }, () => setPlaying(undefined))
    setPlaying(i)
  }

  function hearKit() {
    if (playing === 'kit') return silence()
    const laid = layOut(keys)
    if (!laid.audio.length) return
    play({ sampleRate: TARGET.sampleRate, channels: [laid.audio] }, () => setPlaying(undefined))
    setPlaying('kit')
  }

  function silence() {
    stop()
    setPlaying(undefined)
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
    setName(base)
    setSelected(Math.max(0, slices.findIndex(Boolean)))
    setResult(undefined)
    return true
  }

  async function addFiles(files: File[], from: number) {
    const audio = files.filter((f) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|m4a|ogg|flac)$/i.test(f.name))
    if (!audio.length) return setNote('those are not sounds — try wav, aiff or mp3.')
    setBusy('reading')
    setNote(undefined)
    try {
      if (audio.length === 1) {
        const bytes = new Uint8Array(await audio[0].arrayBuffer())
        if (isAiff(bytes) && loadKit(bytes, audio[0].name)) {
          setNote(`${audio[0].name} is a drum kit — its slices are on the keys now.`)
          return
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
      if (r.ok) {
        const free = r.slots.find((s) => !s.files.length && r.tracks.find((t) => t.n === s.track)?.folder)
        if (free) setTarget({ track: free.track, slot: free.slot })
      }
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
      if (!loadKit(bytes, file)) {
        // Not a drum kit: a synth sample, or something plain. Put it on one key.
        update(selected, toSound(file, decodeAiff(bytes)))
        setNote(`${file} has no drum kit in it, so it went on key ${selected + 1} as one sound.`)
      } else {
        setNote(`opened ${file} from track ${track}, slot ${slot}.`)
      }
      setTarget({ track, slot })
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  function kitBytes() {
    return encodeDrumKit(name.trim() || 'kit', layOut(keys))
  }

  function download() {
    save(kitBytes(), kitFileName(name))
  }

  async function write() {
    if (!disk) return
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
  const live = useRef({ keys, selected, playing })
  live.current = { keys, selected, playing }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || confirming) return
      if (t.closest('input, select, textarea, [contenteditable]')) return
      const k = e.key.toLowerCase()
      const i = COMPUTER_KEYS.indexOf(k)
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
      else if (k === 'delete' || k === 'backspace') update(live.current.selected, undefined)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming])
  const hearRef = useRef(hear)
  hearRef.current = hear

  const art = useMemo(() => kitArt(name, keys.map((s) => (s ? { name: s.name, tone: keyTone(s) } : undefined))), [name, keys])
  const targetSlot = report?.slots.find((s) => s.track === target.track && s.slot === target.slot)
  const yours = report?.slots.filter((s) => s.files.some((f) => f.kind !== 'factory')).length ?? 0
  const writeName = report ? freeName(takenNames(report, target.track, target.slot), kitFileName(name)) : kitFileName(name)
  const canWrite = !!disk && !!report?.ok && count > 0 && !over && !busy && !!report.tracks.find((t) => t.n === target.track)?.folder

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
            title="Pad Gnome: samples onto the pads of a Roland SP-404SX">pad gnome</a>
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
                <span>disk <b className="font-medium text-ink">{disk.name || 'open'}</b> · {yours} kit{yours === 1 ? '' : 's'} of yours on it</span>
              ) : (
                <span>no disk open</span>
              )}
              <span aria-hidden>·</span>
              <span><b className="font-medium text-ink">{count}</b> of 24 keys · {kb(kitSize(used))}</span>
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
                title="the kit as an .aif — drop it in a slot folder on the op-z yourself">
                download .aif
              </button>
              <button type="button" disabled={!canWrite} onClick={() => setConfirming(true)} className={primary}>
                write to op-z
              </button>
            </div>
          </div>

          <Unverified />

          {report && !report.ok && (
            <p className="data m-0 border-b border-rule bg-orange-soft px-3.5 py-2 text-ink">{report.problem}</p>
          )}
          {report?.ok && report.rejected.length > 0 && (
            <p className="label m-0 border-b border-rule px-3.5 py-2">
              the op-z rejected these last time: {report.rejected.join(', ')}
            </p>
          )}

          {/* Name and the 12-second budget */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-3.5 py-2.5">
            <label className="label flex items-center gap-2">
              kit
              <input value={name} maxLength={24} onChange={(e) => { setName(e.target.value); setResult(undefined) }}
                className="data w-40 border border-rule bg-paper px-1.5 py-0.5 text-ink" aria-label="kit name" />
            </label>
            <Budget keys={keys} used={used} />
            <button type="button" className={bar} disabled={!count} onClick={hearKit}>
              {playing === 'kit' ? 'stop' : 'play kit'}
            </button>
          </div>

          <div className="grid gap-0 md:grid-cols-[1fr_300px]">
            {/* Two octaves, high above low, as on a keyboard seen from the player */}
            <div className="flex flex-col gap-2.5 p-3.5 md:border-r md:border-rule">
              {[12, 0].map((row) => (
                <div key={row} className="grid grid-cols-6 gap-1.5 sm:grid-cols-12">
                  {Array.from({ length: 12 }, (_, j) => {
                    const i = row + j
                    return (
                      <Key key={i} i={i} sound={keys[i]} selected={selected === i} playing={playing === i}
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
              </p>
            </div>

            {/* The selected key */}
            <aside className="flex flex-col gap-4 border-t border-rule p-3.5 md:border-t-0">
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
            </aside>
          </div>

          {(busy || note) && (
            <p className="label m-0 border-t border-rule bg-panel px-3.5 py-2 text-ink" role="status">{busy ? `${busy}…` : note}</p>
          )}
        </section>

        {disk && report?.ok && (
          <section className="border border-rule bg-paper" aria-label="the op-z's drum slots">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule bg-panel px-3.5 py-2.5">
              <span className="label">drum slots on the op-z · pick where the kit goes, or open one to edit it</span>
              <span className="label">writing to <b className="font-medium text-ink">track {target.track}, slot {target.slot}</b></span>
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
                  {DRUM_TRACKS.map((t) => {
                    const folder = report.tracks.find((x) => x.n === t.n)?.folder
                    return (
                      <tr key={t.n}>
                        <td className="label p-1">{t.n} {t.name}</td>
                        {Array.from({ length: SLOTS }, (_, j) => {
                          const s = report.slots.find((x) => x.track === t.n && x.slot === j + 1)!
                          const on = target.track === t.n && target.slot === j + 1
                          const file = s.files.find((f) => f.kind !== 'factory') ?? s.files[0]
                          return (
                            <td key={j} className="p-0.5">
                              <button type="button" disabled={!folder} onClick={() => setTarget({ track: t.n, slot: j + 1 })}
                                onDoubleClick={() => file?.kind === 'kit' && void openSlot(t.n, j + 1, file.name)}
                                title={file ? `${describe(file)}${file.kind === 'kit' ? ' — double-click to open it' : ''}` : 'empty'}
                                className={`data h-9 w-full min-w-14 truncate border px-1 text-[11px] disabled:opacity-30
                                  ${on ? 'border-orange bg-orange-soft text-ink' : file?.kind === 'factory' ? 'border-rule-soft bg-paper text-mute' : file ? 'border-rule bg-panel text-ink' : 'border-dashed border-rule-soft text-mute'}`}>
                                {file ? shortName(file) : '·'}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {targetSlot?.files[0] && (
                <p className="label m-0 mt-2 flex flex-wrap items-center gap-2">
                  this slot holds {targetSlot.files.map(describe).join('; ')} — writing replaces it.
                  {targetSlot.files.filter((f) => f.kind === 'kit').map((f) => (
                    <button key={f.name} type="button" className={bar} onClick={() => void openSlot(target.track, target.slot, f.name)}>
                      open {f.name} here
                    </button>
                  ))}
                </p>
              )}
              <p className="label m-0 mt-2">
                dim cells are factory kits. once the op-z imports a kit it keeps the audio inside and leaves a 0-byte
                ~name.aif on the disk, so those can't be opened or saved from here — keep your own copy.
              </p>
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
              eject the op-z properly: it imports the kit as it leaves content mode, and the file on the disk becomes a 0-byte
              ~{result.written} — that is normal. open the op-z here again afterwards and zed gnome shows what its import log said.
            </p>
            {result.cleared.length > 0 && (
              <p className="label m-0 mt-2 text-ink">
                cleared {result.cleared.map(describe).join('; ')} from the slot.
              </p>
            )}
            {result.replaced.length > 0 && (
              <p className="label m-0 mt-2 flex flex-wrap items-center gap-2 text-ink">
                replaced {result.replaced.map((r) => r.name).join(', ')}. the op-z has no room for backups, so the old kit is
                only in this page:
                {result.replaced.map((r) => (
                  <button key={r.name} type="button" className={bar} onClick={() => save(r.data, r.name)}>save {r.name}</button>
                ))}
              </p>
            )}
          </section>
        )}
      </div>

      {confirming && disk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal aria-label="write to op-z">
          <div className="w-full max-w-md border border-rule bg-paper p-4">
            <p className="data m-0 font-medium">write {writeName} to track {target.track}, slot {target.slot}?</p>
            <p className="label m-0 mt-2">
              {count} key{count === 1 ? '' : 's'} · {secs(used)} of 12 s · {kb(kitSize(used))}.
              {writeName !== kitFileName(name) && ` another slot already uses ${kitFileName(name)}, so it goes in as ${writeName}.`}
              {!targetSlot?.files.length && ' the slot is empty.'}
            </p>
            {targetSlot?.files.map((f) => (
              <p key={f.name} className={`label m-0 mt-1 ${f.kind === 'kit' ? '' : 'text-orange'}`}>
                {f.kind === 'kit'
                  ? `replaces ${f.name}, which is read into this page first so you can save it afterwards.`
                  : f.kind === 'imported'
                    ? `replaces ${f.name.slice(1)}, a kit already inside the op-z. its audio can't be copied out, so it is gone unless you have it elsewhere.`
                    : `replaces this slot's factory kit (${f.name}). zed gnome can't copy factory kits out.`}
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
  onSelect: () => void
  onPlay: () => void
  onDropFiles: (files: File[]) => void
  onDropKey: (from: number) => void
}) {
  const { i, sound, selected, playing } = props
  const [over, setOver] = useState(false)
  const shape = useMemo(() => (sound ? envelope({ sampleRate: TARGET.sampleRate, channels: [render(sound)] }, 20) : undefined), [sound])
  const sharp = isSharp(i)

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`key ${i + 1}${sound ? `: ${sound.name}` : ', empty'}${playing ? ', playing' : ''}`}
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
        ${sound ? 'border-orange bg-orange-soft' : sharp ? 'border-rule bg-panel' : 'border-rule bg-paper'}
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
      <span className="data truncate text-[10.5px] text-ink" title={sound?.name}>{sound?.name ?? ''}</span>
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

/** The 12 seconds as a strip, each key's share in turn, so it is plain which sound is eating the budget. */
function Budget({ keys, used }: { keys: Keys; used: number }) {
  const over = used > MAX_FRAMES
  return (
    <div className="flex min-w-[220px] flex-1 items-center gap-2">
      <div className="relative flex h-3 flex-1 overflow-hidden border border-rule bg-panel" role="meter" aria-label="kit length"
        aria-valuemin={0} aria-valuemax={12} aria-valuenow={Number((used / TARGET.sampleRate).toFixed(2))}>
        {keys.map((s, i) => {
          if (!s) return null
          const w = (frames(s) / Math.max(used, MAX_FRAMES)) * 100
          return <span key={i} title={`key ${i + 1}: ${s.name}, ${secs(frames(s))}`} style={{ width: `${w}%` }}
            className={`h-full border-r border-paper ${i % 2 ? 'bg-ink/45' : 'bg-ink/70'}`} />
        })}
        {over && <span className="absolute top-0 bottom-0 border-l-2 border-orange" style={{ left: `${(MAX_FRAMES / used) * 100}%` }} />}
      </div>
      <span className={`data whitespace-nowrap text-[12px] ${over ? 'text-orange' : 'text-ink'}`}>
        {secs(used)} / 12 s{over ? ' — too long' : ''}
      </span>
    </div>
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

/** Mic Gnome's preview banner: the format is sourced, but not yet tried on a unit. */
function Unverified() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('zedgnome:format-note-dismissed') === '1'
    } catch {
      return false
    }
  })
  if (hidden) return null
  return (
    <p className="label m-0 flex items-baseline justify-between gap-4 border-b border-rule bg-panel px-3.5 py-2 leading-relaxed">
      <span>
        the kit format comes from open-source tools people use with their op-1s and op-zs, but zed gnome <b className="font-medium text-orange">hasn't
        been tried on an op-z yet</b>. it writes one mono aiff per kit with the op-1 drum settings inside, and keeps anything it replaces for you to save.
      </span>
      <button type="button" className="shrink-0 underline hover:text-orange" onClick={() => {
        try { localStorage.setItem('zedgnome:format-note-dismissed', '1') } catch { /* this session is enough */ }
        setHidden(true)
      }}>got it</button>
    </p>
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

/** One slot entry, as a person would say it. */
function describe(f: SlotFile): string {
  if (f.kind === 'factory') return `the factory kit (${f.name})`
  if (f.kind === 'imported') return `${f.name.slice(1)}, already inside the op-z`
  return `${f.name}, ${kb(f.bytes)}`
}

const shortName = (f: SlotFile) => (f.kind === 'factory' ? 'factory' : f.name.replace(/^~/, '').replace(/\.aiff?$/i, ''))

/** A word on the import log's last run, for its summary line. */
function importVerdict(lines: string[]): string {
  const bad = lines.filter((l) => /fail|can't|full/i.test(l)).length
  const good = lines.filter((l) => /importing .*success/i.test(l)).length
  if (bad) return ` · ${bad} problem${bad === 1 ? '' : 's'}`
  if (good) return ` · ${good} kit${good === 1 ? '' : 's'} imported`
  return ''
}

const secs = (n: number) => `${(n / TARGET.sampleRate).toFixed(2)} s`
/** The written file: 16-bit mono plus about 1.5 kb of header and settings. */
const kitSize = (n: number) => Math.min(n, MAX_FRAMES) * 2 + 1600
const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} kb` : `${(bytes / 1024 / 1024).toFixed(1)} mb`)
