// Delegated sign-in for the direct CLI/MCP mode (#836).
//
// Same public client as the Planner web app, scoped to its own app folder.
// Tokens live only in this process's memory: never written, printed or
// accepted as arguments. Muse does not use this path (its broker holds the
// refresh token and runs the tokenless `plan` transport instead).
import { ToolError } from './errors.js'

export const CLIENT_ID = '4f22242f-c9a7-4a61-9208-8ca0e5ef8697'
export const SCOPES = 'Files.ReadWrite.AppFolder offline_access'
const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0'

/** Capture PLANNER_ACCESS_TOKEN once and remove it from the environment. */
export function environmentAuth(env = process.env) {
  const token = env.PLANNER_ACCESS_TOKEN || null
  delete env.PLANNER_ACCESS_TOKEN
  return async () => token
}

export async function deviceAuth({ fetchImpl = fetch, log = (m) => process.stderr.write(`${m}\n`), sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const post = async (path, body) => {
    const response = await fetchImpl(`${AUTHORITY}/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
    })
    return { status: response.status, json: await response.json().catch(() => ({})) }
  }
  const start = await post('devicecode', { client_id: CLIENT_ID, scope: SCOPES })
  if (start.status !== 200) {
    throw new ToolError('AUTH_UNAVAILABLE', `Device-code sign-in is not enabled for the Focus Planner app (${start.json.error || start.status}). Its owner must turn on "Allow public client flows".`)
  }
  log(start.json.message)
  let interval = (start.json.interval || 5) * 1000
  const deadline = Date.now() + (start.json.expires_in || 900) * 1000
  let tokens = null
  while (!tokens && Date.now() < deadline) {
    await sleep(interval)
    const poll = await post('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: start.json.device_code })
    if (poll.status === 200) tokens = poll.json
    else if (poll.json.error === 'slow_down') interval += 5000
    else if (poll.json.error !== 'authorization_pending') throw new ToolError('AUTH_REQUIRED', `Sign-in failed: ${poll.json.error || poll.status}.`)
  }
  if (!tokens) throw new ToolError('AUTH_REQUIRED', 'Sign-in timed out.')
  let expiresAt = Date.now() + (tokens.expires_in - 120) * 1000
  return async () => {
    if (Date.now() < expiresAt) return tokens.access_token
    const refreshed = await post('token', { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: tokens.refresh_token, scope: SCOPES })
    if (refreshed.status !== 200) throw new ToolError('AUTH_REQUIRED', 'Sign-in expired; restart and sign in again.')
    tokens = { ...tokens, ...refreshed.json }
    expiresAt = Date.now() + (tokens.expires_in - 120) * 1000
    return tokens.access_token
  }
}
