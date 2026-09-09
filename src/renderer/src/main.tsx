import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { getDesktopApi } from './api'
import './styles.css'

let startupError: string | undefined
try { getDesktopApi() } catch (error) { startupError = error instanceof Error ? error.message : String(error) }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {startupError ? <main className="page-content"><h1>Unable to start Workstack</h1><p role="alert">{startupError}</p></main> : <App />}
  </StrictMode>
)
