import '#planner/storage-bootstrap'
import './registerAppShell.js'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DefaultHostProvider } from '#planner/host-provider'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DefaultHostProvider>
      <App />
    </DefaultHostProvider>
  </StrictMode>,
)
