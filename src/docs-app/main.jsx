import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './docs.css'
import DocsApp from './DocsApp.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DocsApp />
  </StrictMode>,
)
