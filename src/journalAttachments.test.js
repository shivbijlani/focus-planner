import { describe, it, expect } from 'vitest'
import {
  attachmentFolderPath,
  filenameFromUrl,
  formatAttachmentFolderMarkdown,
  formatAttachmentMarkdown,
  isImageAttachment,
  normalizeAttachmentUrl,
  taskIdFromJournalPath,
} from './journalAttachments.js'

describe('journal attachment helpers', () => {
  it('extracts task ids from journal paths', () => {
    expect(taskIdFromJournalPath('journal/task-313.md')).toBe('313')
    expect(taskIdFromJournalPath('s2::journal\\task-42.md')).toBe('42')
    expect(taskIdFromJournalPath('journal/notes.md')).toBeNull()
  })

  it('computes the per-task attachment folder convention', () => {
    expect(attachmentFolderPath(313)).toBe('journal/task-313-files')
    expect(attachmentFolderPath('')).toBeNull()
    expect(attachmentFolderPath('abc')).toBeNull()
  })

  it('normalizes common Google Drive share URLs', () => {
    expect(normalizeAttachmentUrl('drive.google.com/open?id=abc123')).toBe('https://drive.google.com/file/d/abc123/view?usp=sharing')
    expect(normalizeAttachmentUrl('<https://drive.google.com/file/d/abc123/view>')).toBe('https://drive.google.com/file/d/abc123/view?usp=sharing')
  })

  it('normalizes OneDrive URLs without changing their share token', () => {
    expect(normalizeAttachmentUrl('1drv.ms/i/s!abc?e=xyz')).toBe('https://1drv.ms/i/s!abc?e=xyz')
    expect(normalizeAttachmentUrl('https://onedrive.live.com/?id=abc&cid=def')).toBe('https://onedrive.live.com/?id=abc&cid=def')
  })

  it('formats image attachments as markdown images', () => {
    expect(formatAttachmentMarkdown({ url: 'https://example.com/cat.PNG', name: 'Cat [today]' }))
      .toBe('![Cat today](https://example.com/cat.PNG)')
    expect(formatAttachmentMarkdown({ url: 'data:image/png;base64,abc', name: 'screen', kind: 'auto' }))
      .toBe('![screen](data:image/png;base64,abc)')
  })

  it('formats non-image attachments as clickable markdown links', () => {
    expect(formatAttachmentMarkdown({ url: 'https://example.com/report.pdf', name: 'Report' }))
      .toBe('[Report](https://example.com/report.pdf)')
    expect(formatAttachmentMarkdown({ url: 'https://example.com/photo.jpg', name: 'Photo', kind: 'file' }))
      .toBe('[Photo](https://example.com/photo.jpg)')
  })

  it('formats folder links with a task-specific label', () => {
    expect(formatAttachmentFolderMarkdown({ taskId: 313, url: 'https://1drv.ms/f/s!folder' }))
      .toBe('[Task 313 attachments folder](https://1drv.ms/f/s!folder)')
  })

  it('detects image attachments from mime type, file name, url, and data URLs', () => {
    expect(isImageAttachment({ mimeType: 'image/webp' })).toBe(true)
    expect(isImageAttachment({ name: 'diagram.svg' })).toBe(true)
    expect(isImageAttachment({ url: 'https://example.com/a.jpeg?x=1' })).toBe(true)
    expect(isImageAttachment({ url: 'data:image/gif;base64,abc' })).toBe(true)
    expect(isImageAttachment({ name: 'notes.pdf' })).toBe(false)
  })

  it('falls back to a filename from the URL', () => {
    expect(filenameFromUrl('https://example.com/folder/My%20Doc.pdf?download=1')).toBe('My Doc.pdf')
    expect(formatAttachmentMarkdown({ url: 'https://example.com/folder/My%20Doc.pdf?download=1' }))
      .toBe('[My Doc.pdf](https://example.com/folder/My%20Doc.pdf?download=1)')
  })
})
