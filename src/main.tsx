import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Board } from './ui/Board'
import { applyStoredTheme } from './ui/Theme'

applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
)
