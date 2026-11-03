import { resetBrowser, RESET_KEY, RESET_CONFIRMED_KEY, RESET_CONFIRMATION } from './storage/reset.js'
import './resetPage.css'

const button = document.getElementById('reset')
const status = document.getElementById('status')
const cancel = document.querySelector('a')
async function runReset() {
  button.disabled = true
  button.hidden = true
  cancel.hidden = true
  status.textContent = 'Resetting and signing out... Your cloud backups are kept.'
  try {
    await resetBrowser()
    status.textContent = 'Reset complete. Opening a fresh planner. Sign in under Settings to restore your backup.'
    window.location.replace(new URL('./', window.location.href))
  } catch (error) {
    console.error('Planner reset failed:', error)
    status.textContent = `Reset not completed: ${error.message}`
    button.disabled = false
    button.hidden = false
    button.textContent = 'Retry reset'
  }
}
button.addEventListener('click', () => {
  if (window.confirm(RESET_CONFIRMATION)) runReset()
})
if (sessionStorage.getItem(RESET_CONFIRMED_KEY) === '1') {
  sessionStorage.removeItem(RESET_CONFIRMED_KEY)
  runReset()
} else {
  status.textContent = localStorage.getItem(RESET_KEY)
    ? 'Reset was interrupted. Retry to finish signing out.'
    : 'Clear this browser and sign out. Cloud backups are kept.'
  button.hidden = false
  cancel.hidden = !!localStorage.getItem(RESET_KEY)
}
