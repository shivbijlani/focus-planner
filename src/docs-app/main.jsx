import '#planner/storage-bootstrap'
import '../registerAppShell.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DefaultHostProvider } from '#planner/host-provider'
import './docs.css'
import DocsApp from './DocsApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DefaultHostProvider>
      <DocsApp />
    </DefaultHostProvider>
  </StrictMode>,
)
