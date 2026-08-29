const IMAGE_EXT_RE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i
const DRIVE_OPEN_ID_RE = /^https:\/\/drive\.google\.com\/open\?id=([^&]+)/i
const DRIVE_FILE_ID_RE = /^https:\/\/drive\.google\.com\/file\/d\/([^/]+)/i

export function taskIdFromJournalPath(path) {
  const m = String(path || '').match(/(?:^|[/\\])task-(\d+)\.md$/)
  return m ? m[1] : null
}

export function attachmentFolderPath(taskId) {
  const id = String(taskId || '').trim()
  if (!/^\d+$/.test(id)) return null
  return `journal/task-${id}-files`
}

export function normalizeAttachmentUrl(input) {
  let url = String(input || '').trim()
  if (!url) return ''
  url = url.replace(/^<(.+)>$/, '$1').trim()
  if (/^(drive\.google\.com|docs\.google\.com|1drv\.ms|onedrive\.live\.com)\b/i.test(url)) {
    url = `https://${url}`
  }

  const driveOpen = url.match(DRIVE_OPEN_ID_RE)
  if (driveOpen) return `https://drive.google.com/file/d/${encodeURIComponent(decodeURIComponent(driveOpen[1]))}/view?usp=sharing`

  const driveFile = url.match(DRIVE_FILE_ID_RE)
  if (driveFile && !/[?&]usp=/.test(url)) {
    return url.replace(/\/view(?:\?.*)?$/i, '/view?usp=sharing')
  }

  return url
}

export function isImageAttachment({ url = '', name = '', mimeType = '' } = {}) {
  return String(mimeType).toLowerCase().startsWith('image/')
    || IMAGE_EXT_RE.test(String(name))
    || IMAGE_EXT_RE.test(String(url))
    || String(url).startsWith('data:image/')
}

export function formatAttachmentMarkdown({ url, name, mimeType, kind = 'auto' } = {}) {
  const normalizedUrl = normalizeAttachmentUrl(url)
  if (!normalizedUrl) return ''
  const label = sanitizeMarkdownLabel(name || filenameFromUrl(normalizedUrl) || 'attachment')
  const asImage = kind === 'image' || (kind === 'auto' && isImageAttachment({ url: normalizedUrl, name, mimeType }))
  return asImage ? `![${label}](${normalizedUrl})` : `[${label}](${normalizedUrl})`
}

export function formatAttachmentFolderMarkdown({ taskId, url, label } = {}) {
  const normalizedUrl = normalizeAttachmentUrl(url)
  if (!normalizedUrl) return ''
  const fallback = taskId ? `Task ${taskId} attachments folder` : 'Attachments folder'
  return `[${sanitizeMarkdownLabel(label || fallback)}](${normalizedUrl})`
}

export function filenameFromUrl(url) {
  const raw = String(url || '')
  if (raw.startsWith('data:')) return ''
  try {
    const u = new URL(raw)
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last ? decodeURIComponent(last) : ''
  } catch {
    const last = raw.split(/[/?#]/).filter(Boolean).pop()
    return last ? decodeURIComponent(last) : ''
  }
}

function sanitizeMarkdownLabel(label) {
  return String(label || 'attachment')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]]/g, '')
    .trim() || 'attachment'
}
