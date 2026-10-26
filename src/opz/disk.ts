/**
 * Reading and writing the OP-Z's disk in content mode.
 *
 * The disk is reached through a tiny directory interface so the whole write
 * path runs in tests against an in-memory disk. Rules:
 *
 *   1. never write to a disk that does not look like an OP-Z — it makes its
 *      own samplepacks folders and we do not invent them
 *   2. the OP-Z has 24 MB in all, so backups do not go on it: the kit being
 *      replaced is read into the page first, checked, and handed back as a
 *      download
 *   3. one kit per slot, so the kit in the slot is what is replaced, and a
 *      slot holding something we cannot see is never written to
 *
 * What the disk shows is the device's export, not a plain folder (from TE's
 * how_to_import.txt on the disk, and a real unit):
 *
 *   - a 0-byte `~name.aif` is a slot playing a pack held somewhere else: a
 *     factory kit inside the OP-Z, or the same pack as another slot. A synth
 *     slot playing one of the device's own synths holds `~13.engine`. Your own
 *     kits and samples stay on the disk as full .aif files after import
 *   - only one pack per slot folder is imported; the rest are rejected
 *   - a pack declared twice under one name makes the device clear both slots
 *     (ioma8/opz-firmware-notes), so every kit we write gets a name no other
 *     slot uses
 *   - `import.log` at the disk root records the last import, line by line
 *
 * Chrome's File System Access API will not list or open a name that starts
 * or ends with `~` (base::i18n::IsFilenameLegal), so those slots list as
 * empty. Deleting a folder still fails on anything inside it, listed or not,
 * so a slot that lists as empty only counts as empty once deleting it works,
 * and it is made again straight away.
 */
import { readMeta } from './drumkit'
import { SAMPLE_DIR, SLOTS, TRACKS, isDrumTrack, leadingNumber } from './layout'

export interface Dir {
  name: string
  entries(): Promise<{ name: string; kind: 'file' | 'directory' }[]>
  dir(name: string, create?: boolean): Promise<Dir | undefined>
  read(name: string): Promise<Uint8Array | undefined>
  write(name: string, data: Uint8Array): Promise<void>
  remove(name: string): Promise<void>
  /** Delete an empty folder. False, with nothing changed, if anything is in it, even names entries() leaves out. */
  rmdir(name: string): Promise<boolean>
}

export interface SlotFile {
  name: string
  bytes: number
}

export interface DiskSlot {
  track: number
  slot: number
  /** The slot folder's name as it is on the disk, if it exists. */
  folder?: string
  /** Kits on the disk, with their audio. */
  files: SlotFile[]
  /**
   * Something is in the folder that we cannot show: nearly always a ~ marker
   * for a factory kit or a pack another slot plays. We cannot read or remove
   * it, so the slot is not written to.
   */
  hidden: boolean
}

export interface DiskReport {
  ok: boolean
  problem?: string
  /** The eight tracks' folder names on the disk. */
  tracks: { n: number; folder?: string }[]
  slots: DiskSlot[]
  /** Kits the OP-Z refused last time, from its rejected folder. */
  rejected: string[]
  /** The last import's lines from import.log, if the disk root was picked. */
  importLog: string[]
}

/** A kit with its audio on the disk. */
const isAif = (name: string) => /\.aiff?$/i.test(name) && !/^[.~]/.test(name)
/** macOS's AppleDouble files and Finder's folder settings: nothing the OP-Z needs. */
const isLitter = (name: string) => name.startsWith('._') || name === '.DS_Store'

/** A kit's name as the device knows it: markers carry a leading ~. */
const packName = (file: string) => file.replace(/^~/, '').toLowerCase()

/** The name to write under, so no other slot already declares a pack by it. */
export function freeName(taken: string[], name: string): string {
  const used = new Set(taken.map(packName))
  if (!used.has(name.toLowerCase())) return name
  const base = name.replace(/\.aiff?$/i, '')
  for (let i = 2; ; i++) {
    const next = `${base.slice(0, 24 - String(i).length - 1)}-${i}.aif`
    if (!used.has(next)) return next
  }
}

/** Pack names declared outside one slot, from an inspection. */
export function takenNames(report: DiskReport, track: number, slot: number): string[] {
  return report.slots.filter((s) => !(s.track === track && s.slot === slot)).flatMap((s) => s.files.map((f) => f.name))
}

/** The last [IMPORT STARTED] … block of import.log. */
export function lastImport(log: string): string[] {
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const start = lines.map((l) => l.includes('[IMPORT STARTED]')).lastIndexOf(true)
  return start < 0 ? lines.slice(-20) : lines.slice(start)
}

/** The samplepacks folder, whether the disk or the folder itself was picked. */
export async function findSamplepacks(root: Dir): Promise<Dir | undefined> {
  if (root.name.toLowerCase() === SAMPLE_DIR) return root
  return root.dir(SAMPLE_DIR)
}

async function trackDir(packs: Dir, n: number): Promise<Dir | undefined> {
  const hit = (await packs.entries()).find((e) => e.kind === 'directory' && leadingNumber(e.name) === n)
  return hit ? packs.dir(hit.name) : undefined
}

async function slotDir(track: Dir, n: number, create = false): Promise<Dir | undefined> {
  const hit = (await track.entries()).find((e) => e.kind === 'directory' && leadingNumber(e.name) === n)
  if (hit) return track.dir(hit.name)
  return create ? track.dir(String(n).padStart(2, '0'), true) : undefined
}

/** The slot folder made again if it was empty; undefined if anything is in it. Deleting is the only look past the listing. */
async function emptied(track: Dir, folder: string): Promise<Dir | undefined> {
  return (await track.rmdir(folder)) ? track.dir(folder, true) : undefined
}

/** A slot's kits, and whether anything else we cannot show is in it. */
async function look(track: Dir, d: Dir): Promise<Pick<DiskSlot, 'files' | 'hidden'>> {
  const listed = await d.entries()
  const files: SlotFile[] = []
  for (const e of listed) if (e.kind === 'file' && isAif(e.name)) files.push({ name: e.name, bytes: (await d.read(e.name))?.byteLength ?? 0 })
  if (files.length) return { files, hidden: false }
  // Nothing listed but litter: clear it so the folder can be tested.
  const rest = listed.filter((e) => !(e.kind === 'file' && isLitter(e.name)))
  if (rest.length) return { files, hidden: true }
  for (const e of listed) await d.remove(e.name)
  return { files, hidden: !(await emptied(track, d.name)) }
}

export async function inspect(root: Dir): Promise<DiskReport> {
  const empty = { tracks: [], slots: [], rejected: [], importLog: [] }
  const packs = await findSamplepacks(root)
  if (!packs) {
    return {
      ok: false,
      problem: 'no samplepacks folder here. switch the op-z on in content mode (hold the track button while turning it on), then pick the disk it mounts.',
      ...empty,
    }
  }
  const tracks: DiskReport['tracks'] = []
  const slots: DiskSlot[] = []
  for (const { n } of TRACKS) {
    const t = await trackDir(packs, n)
    tracks.push({ n, folder: t?.name })
    for (let s = 1; s <= SLOTS; s++) {
      const d = t && (await slotDir(t, s))
      slots.push({ track: n, slot: s, folder: d?.name, ...(t && d ? await look(t, d) : { files: [], hidden: false }) })
    }
  }
  if (!tracks.some((t) => t.folder)) {
    return { ok: false, problem: 'there is a samplepacks folder, but none of the track folders (1 to 8) are in it.', ...empty }
  }
  const rej = (await root.dir('rejected')) ?? (await packs.dir('rejected'))
  const rejected = rej ? await listFiles(rej) : []
  const log = packs === root ? undefined : await root.read('import.log')
  const importLog = log?.byteLength ? lastImport(new TextDecoder().decode(log)) : []
  return { ok: true, tracks, slots, rejected, importLog }
}

/** Files under a folder, as relative paths: the device keeps the rejected file's own path. */
async function listFiles(d: Dir, prefix = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await d.entries()) {
    if (e.name.startsWith('.')) continue
    if (e.kind === 'file') out.push(prefix + e.name)
    else {
      const sub = await d.dir(e.name)
      if (sub) out.push(...(await listFiles(sub, `${prefix}${e.name}/`)))
    }
  }
  return out
}

/** Read one kit off the disk, for listening to or editing. */
export async function readSlotFile(root: Dir, track: number, slot: number, name: string): Promise<Uint8Array | undefined> {
  const packs = await findSamplepacks(root)
  const t = packs && (await trackDir(packs, track))
  const d = t && (await slotDir(t, slot))
  return d?.read(name)
}

export interface WriteResult {
  /** The file name used, which differs from the one asked for if another slot already had it. */
  written: string
  path: string
  /** Kits whose audio was on the disk, kept in the page so they can be saved. */
  replaced: { name: string; data: Uint8Array }[]
  madeSlot: boolean
}

/** A drum kit or a synth sample into its slot: tracks 1–4 take kits, 5–8 samples. */
export async function writeKit(root: Dir, track: number, slot: number, name: string, data: Uint8Array): Promise<WriteResult> {
  if (!TRACKS.some((t) => t.n === track)) throw new Error(`there is no track ${track}.`)
  if (slot < 1 || slot > SLOTS) throw new Error(`there is no slot ${slot}.`)
  const kind = readMeta(data)?.type
  if (kind && kind !== (isDrumTrack(track) ? 'drum' : 'sampler')) {
    throw new Error(`track ${track} takes ${isDrumTrack(track) ? 'drum kits' : 'synth samples'}, and this is a ${kind === 'drum' ? 'drum kit' : 'synth sample'} — nothing was written.`)
  }
  const packs = await findSamplepacks(root)
  if (!packs) throw new Error('no samplepacks folder — nothing was written.')
  const t = await trackDir(packs, track)
  if (!t) throw new Error(`no folder for track ${track} in samplepacks — nothing was written.`)
  const existed = await slotDir(t, slot)

  // Every pack name declared in any other slot, so this one never doubles one up.
  const taken: string[] = []
  for (const { n } of TRACKS) {
    const td = await trackDir(packs, n)
    for (let s = 1; td && s <= SLOTS; s++) {
      if (n === track && s === slot) continue
      const sd = await slotDir(td, s)
      if (sd) taken.push(...(await sd.entries()).filter((e) => e.kind === 'file' && isAif(e.name)).map((e) => e.name))
    }
  }
  const written = freeName(taken, name)
  let d = existed ?? (await slotDir(t, slot, true))!

  // Keep what is being replaced before touching anything.
  const replaced: WriteResult['replaced'] = []
  const litter: string[] = []
  for (const e of await d.entries()) {
    if (e.kind !== 'file') continue
    if (isLitter(e.name)) litter.push(e.name)
    else if (isAif(e.name)) {
      const old = await d.read(e.name)
      if (!old) throw new Error(`could not read ${e.name} to keep a copy — nothing was changed.`)
      replaced.push({ name: e.name, data: old })
    }
  }

  // The folder must be empty now; if something unlisted is still in it, the kit goes back.
  for (const n of [...replaced.map((r) => r.name), ...litter]) await d.remove(n)
  const fresh = existed ? await emptied(t, d.name) : d
  if (!fresh) {
    for (const r of replaced) await d.write(r.name, r.data)
    throw new Error(`track ${track}, slot ${slot} holds something zed gnome can't show — one of the op-z's own sounds, or a pack another slot also plays. nothing was written.`)
  }
  d = fresh
  await d.write(written, data)
  const check = await d.read(written)
  if (!check || check.byteLength !== data.byteLength) throw new Error(`${written} did not verify after writing — try again before ejecting.`)
  // Chrome marks what it writes as downloaded, and on the OP-Z's FAT disk macOS keeps that in a ._ file beside the kit.
  for (const e of await d.entries()) if (e.kind === 'file' && isLitter(e.name)) await d.remove(e.name)
  return { written, path: `${SAMPLE_DIR}/${t.name}/${d.name}/${written}`, replaced, madeSlot: !existed }
}

/** The browser's directory handle, behind the Dir interface. */
export function handleDir(handle: FileSystemDirectoryHandle): Dir {
  return {
    name: handle.name,
    async entries() {
      const out: { name: string; kind: 'file' | 'directory' }[] = []
      for await (const [name, h] of handle.entries()) out.push({ name, kind: h.kind })
      return out
    },
    async dir(name, create = false) {
      // FAT is case-insensitive, the API is not: match the name as it exists.
      for await (const [n, h] of handle.entries()) {
        if (h.kind === 'directory' && n.toLowerCase() === name.toLowerCase()) return handleDir(h as FileSystemDirectoryHandle)
      }
      if (!create) return undefined
      return handleDir(await handle.getDirectoryHandle(name, { create: true }))
    },
    async read(name) {
      try {
        return new Uint8Array(await (await (await handle.getFileHandle(name)).getFile()).arrayBuffer())
      } catch {
        return undefined
      }
    },
    async write(name, data) {
      const writable = await (await handle.getFileHandle(name, { create: true })).createWritable()
      await writable.write(data as BlobPart)
      await writable.close()
    },
    async remove(name) {
      await handle.removeEntry(name)
    },
    async rmdir(name) {
      try {
        await handle.removeEntry(name)
        return true
      } catch (e) {
        // What Chrome says when the folder has anything in it.
        if ((e as DOMException).name === 'InvalidModificationError') return false
        throw e
      }
    },
  }
}

/** Names Chrome's File System Access API will not list or open: ~, a dot or a space at either end, after one leading dot. */
const browserHides = (name: string) => /^[~.\s]|[~.\s]$/.test(name.replace(/^\./, ''))
const notAllowed = () => new TypeError('Name is not allowed.')

/** An in-memory disk, for tests. It hides names as Chrome does; put a marker in through `files`. */
export interface MemoryDir extends Dir {
  files: Map<string, Uint8Array>
  dirs: Map<string, MemoryDir>
}

/** `appleDouble`: every write leaves a ._ file too, as macOS does on the OP-Z's disk when Chrome writes. */
export function memoryDir(name = 'OP-Z', opts: { appleDouble?: boolean } = {}): MemoryDir {
  const files = new Map<string, Uint8Array>()
  const dirs = new Map<string, MemoryDir>()
  const find = (n: string) => [...dirs.entries()].find(([k]) => k.toLowerCase() === n.toLowerCase())
  return {
    name,
    files,
    dirs,
    async entries() {
      return [...[...dirs.keys()].map((n) => ({ name: n, kind: 'directory' as const })), ...[...files.keys()].map((n) => ({ name: n, kind: 'file' as const }))]
        .filter((e) => !browserHides(e.name))
    },
    async dir(n, create = false) {
      const hit = find(n)
      if (hit) return hit[1]
      if (!create) return undefined
      const d = memoryDir(n, opts)
      dirs.set(n, d)
      return d
    },
    async read(n) {
      return browserHides(n) ? undefined : files.get(n)
    },
    async write(n, data) {
      if (browserHides(n)) throw notAllowed()
      files.set(n, data.slice())
      if (opts.appleDouble && !n.startsWith('._')) files.set(`._${n}`, new Uint8Array(4096))
    },
    async remove(n) {
      if (browserHides(n)) throw notAllowed()
      if (!files.delete(n)) throw new Error(`${n} not found`)
    },
    async rmdir(n) {
      const hit = find(n)
      if (!hit) throw new Error(`${n} not found`)
      if (hit[1].files.size || hit[1].dirs.size) return false
      dirs.delete(hit[0])
      return true
    },
  }
}
