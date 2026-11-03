import { resetBrowser, RESET_KEY } from './storage/reset.js'
import './resetPage.css'

const checkbox = document.getElementById('confirm')
const button = document.getElementById('reset')
const status = document.getElementById('status')
const cancel = document.querySelector('a')
if (localStorage.getItem(RESET_KEY)) cancel.hidden = true
checkbox.addEventListener('change', () => { button.disabled = !checkbox.checked })
button.addEventListener('click', async () => {
  button.disabled = true
  checkbox.disabled = true
  cancel.hidden = true
  status.textContent = 'Stopping backup safely, then clearing this browser. This may take up to two minutes.'
  try {
    await resetBrowser()
    status.textContent = 'Reset complete. Opening a fresh planner. Sign in under Settings to restore your backup.'
    window.location.replace(new URL('./', window.location.href))
  } catch (error) {
    console.error('Planner reset failed:', error)
    status.textContent = `Reset not completed: ${error.message} You can retry. Remote backups have not been deleted.`
    button.disabled = false
    checkbox.disabled = false
  }
})
