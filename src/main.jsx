import '#planner/storage-bootstrap'
import './registerAppShell.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DefaultHostProvider } from '#planner/host-provider'
import profile from '#planner/deployment-profile'
import './index.css'
import App from './App.jsx'

document.title = profile.branding.name

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DefaultHostProvider>
      <App />
    </DefaultHostProvider>
  </StrictMode>,
)
