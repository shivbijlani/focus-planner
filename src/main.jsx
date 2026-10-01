import '#planner/storage-bootstrap'
import './registerAppShell.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import profile from '#planner/deployment-profile'
import './index.css'
import { AppRoot } from './AppRoot.jsx'

document.title = profile.branding.name
const favicon = document.querySelector('link[rel="icon"]')
if (favicon && profile.branding.icon) {
  favicon.href = new URL(profile.branding.icon, document.baseURI).href
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
)
