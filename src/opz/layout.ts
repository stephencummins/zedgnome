/**
 * What the OP-Z wants, in one place.
 *
 * A drum kit is one mono AIFF holding up to 24 sounds back to back, one per
 * key, at most 12 seconds in all. In content mode (hold the track button while
 * switching on) the OP-Z mounts as a disk with a samplepacks folder: a folder
 * per track, ten slot folders in each, one .aif per slot. Tracks 1–4 are the
 * drum tracks. Tracks 5–8 are the synth tracks, and take a synth sample: one
 * sound of up to 6 seconds that the keys play at different pitches.
 *
 * The folder names come from Teenage Engineering's guide and people's disks,
 * not from a disk this app has seen, so they are matched by their leading
 * number rather than spelled out.
 */
export const TARGET = { sampleRate: 44100, bitDepth: 16 } as const

export const KEYS = 24
export const MAX_SECONDS = 12
export const MAX_FRAMES = MAX_SECONDS * TARGET.sampleRate

export const DRUM_TRACKS = [
  { n: 1, name: 'kick' },
  { n: 2, name: 'snare' },
  { n: 3, name: 'perc' },
  { n: 4, name: 'fx' },
] as const
export const SYNTH_TRACKS = [
  { n: 5, name: 'bass' },
  { n: 6, name: 'lead' },
  { n: 7, name: 'arp' },
  { n: 8, name: 'chord' },
] as const
export const TRACKS = [...DRUM_TRACKS, ...SYNTH_TRACKS]
export const isDrumTrack = (n: number) => DRUM_TRACKS.some((t) => t.n === n)
export const SLOTS = 10

export const SYNTH_SECONDS = 6
export const SYNTH_FRAMES = SYNTH_SECONDS * TARGET.sampleRate

export const SAMPLE_DIR = 'samplepacks'

/** The note names the 24 keys play, two octaves from F as on the OP-1 and OP-Z. */
const NOTES = ['f', 'f#', 'g', 'g#', 'a', 'a#', 'b', 'c', 'c#', 'd', 'd#', 'e']
export const keyNote = (i: number) => NOTES[i % 12]
export const isSharp = (i: number) => NOTES[i % 12].endsWith('#')
/**
 * Key 1 as a MIDI note: F3, taking the OP-Z's octave 0 to run F3 to E5 so
 * key 8 is middle C. Not yet checked on the device.
 */
export const LOW_NOTE = 53
/** Any MIDI note onto one of the 24 keys, an octave at a time. */
export const noteKey = (note: number) => (((note - LOW_NOTE) % KEYS) + KEYS) % KEYS

/**
 * The computer keys that play each OP-Z key: the tracker layout, z to / for
 * the low octave and q to ] for the high one, black keys on the row above.
 */
export const COMPUTER_KEYS = [
  'z', 's', 'x', 'd', 'c', 'v', 'g', 'b', 'h', 'n', 'j', 'm',
  'q', '2', 'w', '3', 'e', 'r', '5', 't', '6', 'y', '7', 'u',
]

/** A track or slot folder's number from its name: "1-kick" → 1, "01" → 1. */
export function leadingNumber(name: string): number | undefined {
  const m = /^0*(\d{1,2})(?:\D|$)/.exec(name)
  return m ? Number(m[1]) : undefined
}

/** A safe file name for a kit: lowercase, no path characters, never empty. */
export function kitFileName(name: string): string {
  const base = name.toLowerCase().replace(/\.aiff?$/, '').replace(/[^a-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 24)
  return `${base || 'kit'}.aif`
}
