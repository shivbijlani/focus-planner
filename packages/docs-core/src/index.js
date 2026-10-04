export * from './grammar.js'
export * from './doc.js'
export * from './links.js'
export * from './anchor.js'
export * from './review.js'
export * from './readLoad.js'
export * from './validate.js'

/** Storage paths of the on-disk format (plans/docs-app-design.md §4). */
export const DOCS_DIR = 'docs'
export const DOCS_INDEX = 'docs/index.json'
export const docPath = (id) => `docs/${id}/doc.md`
export const reviewPath = (id) => `docs/${id}/review.json`
export const responsePath = (id) => `docs/${id}/response.json`
export const historyPath = (id, rev) => `docs/${id}/history/r${String(rev).padStart(4, '0')}.md`
