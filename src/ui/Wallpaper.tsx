import { useEffect, useRef, useState } from 'react'
import { type Art, artUrl } from './art'

/**
 * The kit's bit-art down the margins either side of the builder, the way
 * TDMDNE wears its beat and Pad Gnome its bank. Two layers so a new picture
 * crossfades in; the CSS masks the middle out so it never sits behind a
 * control or the text. Repainted on a theme flip too, because the canvas
 * holds colours, not variables.
 */
export function Wallpaper({ art }: { art: Art }) {
  const a = useRef<HTMLDivElement>(null)
  const b = useRef<HTMLDivElement>(null)
  const shown = useRef({ on: 0, url: '' })
  const [theme, setTheme] = useState(0)

  useEffect(() => {
    const bump = () => setTheme((t) => t + 1)
    const watch = new MutationObserver(bump)
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    const scheme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
    scheme?.addEventListener?.('change', bump)
    return () => {
      watch.disconnect()
      scheme?.removeEventListener?.('change', bump)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      const url = artUrl(art)
      if (!url || url === shown.current.url) return
      const on = shown.current.on ^ 1
      shown.current = { on, url }
      const [next, prev] = on ? [b.current, a.current] : [a.current, b.current]
      if (!next || !prev) return
      next.style.backgroundImage = `url(${url})`
      next.classList.add('on')
      prev.classList.remove('on')
    }, 150)
    return () => clearTimeout(t)
  }, [art, theme])

  return (
    <>
      <div ref={a} className="wall" aria-hidden />
      <div ref={b} className="wall" aria-hidden />
    </>
  )
}
