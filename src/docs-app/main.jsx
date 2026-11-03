import '#planner/storage-bootstrap'
import '../registerAppShell.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DefaultHostProvider } from '#planner/host-provider'
import './docs.css'
import './standalone.css'
import DocsApp from './DocsApp.jsx'
import { RESET_KEY } from '../storage/reset.js'

if (localStorage.getItem(RESET_KEY)) {
  window.location.replace(`${import.meta.env.BASE_URL}reset.html`)
} else createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DefaultHostProvider>
      <DocsApp />
    </DefaultHostProvider>
  </StrictMode>,
)
