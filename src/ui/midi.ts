/**
 * Notes in from any MIDI keyboard, the OP-Z among them: in normal mode over
 * USB it is a class-compliant MIDI device, and its keys send notes on the
 * channel of the track they play. Every input and channel is heard.
 */
export type NoteHandler = (note: number, on: boolean) => void

export const midiAvailable = () => typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator

/**
 * Asks for MIDI (Chrome asks the person once), then hands every note on and
 * off to `onNote` and the input names to `onInputs`, again whenever something
 * is plugged in or out. Returns a function that stops listening.
 */
export async function listen(onNote: NoteHandler, onInputs: (names: string[]) => void): Promise<() => void> {
  const access = await navigator.requestMIDIAccess()
  const handle = (e: MIDIMessageEvent) => {
    const data = e.data
    if (!data || data.length < 3) return
    const kind = data[0] & 0xf0
    // A note on at velocity 0 is a note off.
    if (kind === 0x90 && data[2] > 0) onNote(data[1], true)
    else if (kind === 0x80 || kind === 0x90) onNote(data[1], false)
  }
  const attach = () => {
    const names: string[] = []
    access.inputs.forEach((input) => {
      input.onmidimessage = handle
      names.push(input.name || 'midi in')
    })
    onInputs(names)
  }
  attach()
  access.onstatechange = attach
  return () => {
    access.onstatechange = null
    access.inputs.forEach((input) => (input.onmidimessage = null))
  }
}
