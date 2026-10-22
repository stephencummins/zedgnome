import { useState } from 'react'

/**
 * Light, dark or fancy, remembered per browser. With nothing stored the page
 * follows the system, which is what most people want and what the CSS already
 * does; the toggle exists for the other people, for checking the dark palette
 * without changing the whole machine, and for fancy, which no system asks for.
 */
type Theme = 'light' | 'dark' | 'fancy'
const ORDER: Theme[] = ['light', 'dark', 'fancy']
const KEY = 'zedgnome:theme'

export function storedTheme(): Theme | undefined {
  try {
    const t = localStorage.getItem(KEY)
    return ORDER.includes(t as Theme) ? (t as Theme) : undefined
  } catch {
    return undefined
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Stamp the choice on the root before anything renders, so there is no flash. */
export function applyStoredTheme() {
  const t = storedTheme()
  if (t) document.documentElement.dataset.theme = t
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme())
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]

  function flip() {
    document.documentElement.dataset.theme = next
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // private window, or storage blocked — the page still switches
    }
    setTheme(next)
  }

  return (
    <button type="button" onClick={flip} className="underline hover:text-orange" aria-label={`switch to ${next} mode`}
      title={`switch to ${next} mode`}>
      {next}
    </button>
  )
}
