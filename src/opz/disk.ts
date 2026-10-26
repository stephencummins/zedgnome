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
 *   3. one kit per slot, so anything else in the slot is part of what is
 *      replaced
 *
 * What the disk shows is the device's export, not a plain folder (from
 * ioma8/opz-firmware-notes, read off a unit's import log):
 *
 *   - a slot holding a factory kit shows a 0-byte `~13.engine` marker naming
 *     its plug, so it is not empty
 *   - once a kit is imported, the device replaces the `.aif` with a 0-byte
 *     `~name.aif` marker; the audio is inside the OP-Z from then on and cannot
 *     be read back off the disk
 *   - a pack declared twice under one name (a real file and a marker, or two
 *     markers) makes the device clear both slots, so every kit we write gets
 *     a name no other slot uses
 *   - `import.log` at the disk root records the last import, line by line
 */
import { DRUM_TRACKS, SAMPLE_DIR, SLOTS, leadingNumber } from './layout'

export interface Dir {
  name: string
  entries(): Promise<{ name: string; kind: 'file' | 'directory' }[]>
  dir(name: string, create?: boolean): Promise<Dir | undefined>
  read(name: string): Promise<Uint8Array | undefined>
  write(name: string, data: Uint8Array): Promise<void>
  remove(name: string): Promise<void>
}

export interface SlotFile {
  name: string
  bytes: number
  /** kit: audio on the disk · imported: a kit already inside the OP-Z · factory: a factory plug's marker */
  kind: 'kit' | 'imported' | 'factory'
}

export interface DiskSlot {
  track: number
  slot: number
  /** The slot folder's name as it is on the disk, if it exists. */
  folder?: string
  files: SlotFile[]
}

export interface DiskReport {
  ok: boolean
  problem?: string
  /** The four drum tracks' folder names on the disk. */
  tracks: { n: number; folder?: string }[]
  slots: DiskSlot[]
  /** Kits the OP-Z refused last time, from its rejected folder. */
  rejected: string[]
  /** The last import's lines from import.log, if the disk root was picked. */
  importLog: string[]
}

const isAif = (name: string) => /\.aiff?$/i.test(name) && !name.startsWith('.')
/** Everything in a slot that declares what it plays; ._ files are macOS's AppleDouble litter. */
const isSlotEntry = (name: string) => isAif(name) || (name.startsWith('~') && /\.(aiff?|engine)$/i.test(name))
const isLitter = (name: string) => name.startsWith('._')

export function slotFile(name: string, bytes: number): SlotFile {
  const kind = name.startsWith('~') ? (/\.engine$/i.test(name) ? 'factory' : 'imported') : 'kit'
  return { name, bytes, kind }
}

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
  for (const { n } of DRUM_TRACKS) {
    const t = await trackDir(packs, n)
    tracks.push({ n, folder: t?.name })
    for (let s = 1; s <= SLOTS; s++) {
      const d = t && (await slotDir(t, s))
      const files: SlotFile[] = []
      if (d) {
        for (const e of await d.entries()) {
          if (e.kind === 'file' && isSlotEntry(e.name)) files.push(slotFile(e.name, (await d.read(e.name))?.byteLength ?? 0))
        }
      }
      slots.push({ track: n, slot: s, folder: d?.name, files })
    }
  }
  if (!tracks.some((t) => t.folder)) {
    return { ok: false, problem: 'there is a samplepacks folder, but none of the drum track folders (1 to 4) are in it.', ...empty }
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
  /** Markers removed: kits already inside the OP-Z, and factory plugs. Nothing to save. */
  cleared: SlotFile[]
  madeSlot: boolean
}

export async function writeKit(root: Dir, track: number, slot: number, name: string, data: Uint8Array): Promise<WriteResult> {
  if (!DRUM_TRACKS.some((t) => t.n === track)) throw new Error(`track ${track} is not a drum track.`)
  if (slot < 1 || slot > SLOTS) throw new Error(`there is no slot ${slot}.`)
  const packs = await findSamplepacks(root)
  if (!packs) throw new Error('no samplepacks folder — nothing was written.')
  const t = await trackDir(packs, track)
  if (!t) throw new Error(`no folder for track ${track} in samplepacks — nothing was written.`)
  const existed = await slotDir(t, slot)

  // Every pack name declared in any other slot, so this one never doubles one up.
  const taken: string[] = []
  for (const { n } of DRUM_TRACKS) {
    const td = await trackDir(packs, n)
    for (let s = 1; td && s <= SLOTS; s++) {
      if (n === track && s === slot) continue
      const sd = await slotDir(td, s)
      if (sd) taken.push(...(await sd.entries()).filter((e) => e.kind === 'file' && isSlotEntry(e.name)).map((e) => e.name))
    }
  }
  const written = freeName(taken, name)
  const d = existed ?? (await slotDir(t, slot, true))!

  // Keep what is being replaced before touching anything.
  const replaced: WriteResult['replaced'] = []
  const cleared: SlotFile[] = []
  const litter: string[] = []
  for (const e of await d.entries()) {
    if (e.kind !== 'file') continue
    if (isLitter(e.name)) {
      litter.push(e.name)
      continue
    }
    if (!isSlotEntry(e.name)) continue
    const old = await d.read(e.name)
    if (!old) throw new Error(`could not read ${e.name} to keep a copy — nothing was changed.`)
    const f = slotFile(e.name, old.byteLength)
    if (f.kind === 'kit' && old.byteLength) replaced.push({ name: e.name, data: old })
    else cleared.push(f)
  }

  for (const n of [...replaced.map((r) => r.name), ...cleared.map((c) => c.name), ...litter]) if (n !== written) await d.remove(n)
  await d.write(written, data)
  const check = await d.read(written)
  if (!check || check.byteLength !== data.byteLength) throw new Error(`${written} did not verify after writing — try again before ejecting.`)
  return { written, path: `${SAMPLE_DIR}/${t.name}/${d.name}/${written}`, replaced, cleared, madeSlot: !existed }
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
  }
}

/** An in-memory disk, for tests. */
export interface MemoryDir extends Dir {
  files: Map<string, Uint8Array>
  dirs: Map<string, MemoryDir>
}

export function memoryDir(name = 'OP-Z'): MemoryDir {
  const files = new Map<string, Uint8Array>()
  const dirs = new Map<string, MemoryDir>()
  return {
    name,
    files,
    dirs,
    async entries() {
      return [...[...dirs.keys()].map((n) => ({ name: n, kind: 'directory' as const })), ...[...files.keys()].map((n) => ({ name: n, kind: 'file' as const }))]
    },
    async dir(n, create = false) {
      const hit = [...dirs.entries()].find(([k]) => k.toLowerCase() === n.toLowerCase())
      if (hit) return hit[1]
      if (!create) return undefined
      const d = memoryDir(n)
      dirs.set(n, d)
      return d
    },
    async read(n) {
      return files.get(n)
    },
    async write(n, data) {
      files.set(n, data.slice())
    },
    async remove(n) {
      if (!files.delete(n)) throw new Error(`${n} not found`)
    },
  }
}
