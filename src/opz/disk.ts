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
 *   3. one .aif per slot, so anything else in the slot is part of what is
 *      replaced
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
}

const isAif = (name: string) => /\.aiff?$/i.test(name) && !name.startsWith('.')

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
  const empty = { tracks: [], slots: [], rejected: [] }
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
          if (e.kind === 'file' && isAif(e.name)) files.push({ name: e.name, bytes: (await d.read(e.name))?.byteLength ?? 0 })
        }
      }
      slots.push({ track: n, slot: s, folder: d?.name, files })
    }
  }
  if (!tracks.some((t) => t.folder)) {
    return { ok: false, problem: 'there is a samplepacks folder, but none of the drum track folders (1 to 4) are in it.', ...empty }
  }
  const rej = (await root.dir('rejected')) ?? (await packs.dir('rejected'))
  const rejected = rej ? (await rej.entries()).filter((e) => e.kind === 'file' && !e.name.startsWith('.')).map((e) => e.name) : []
  return { ok: true, tracks, slots, rejected }
}

/** Read one kit off the disk, for listening to or editing. */
export async function readSlotFile(root: Dir, track: number, slot: number, name: string): Promise<Uint8Array | undefined> {
  const packs = await findSamplepacks(root)
  const t = packs && (await trackDir(packs, track))
  const d = t && (await slotDir(t, slot))
  return d?.read(name)
}

export interface WriteResult {
  written: string
  path: string
  /** What the slot held before, kept in the page so it can be saved. */
  replaced: { name: string; data: Uint8Array }[]
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
  const d = existed ?? (await slotDir(t, slot, true))!

  // Keep what is being replaced before touching anything.
  const replaced: WriteResult['replaced'] = []
  for (const e of await d.entries()) {
    if (e.kind !== 'file' || !isAif(e.name)) continue
    const old = await d.read(e.name)
    if (!old) throw new Error(`could not read ${e.name} to keep a copy — nothing was changed.`)
    replaced.push({ name: e.name, data: old })
  }

  for (const r of replaced) if (r.name !== name) await d.remove(r.name)
  await d.write(name, data)
  const check = await d.read(name)
  if (!check || check.byteLength !== data.byteLength) throw new Error(`${name} did not verify after writing — try again before ejecting.`)
  return { written: name, path: `${SAMPLE_DIR}/${t.name}/${d.name}/${name}`, replaced, madeSlot: !existed }
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
