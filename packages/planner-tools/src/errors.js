export class ToolError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function requireValue(condition, message, code = 'INVALID_INPUT') {
  if (!condition) throw new ToolError(code, message)
}

export function safeError(error) {
  if (error instanceof ToolError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details }
  }
  return { code: 'INTERNAL_ERROR', message: 'The tool failed unexpectedly. No change is claimed; re-read and retry with the same operationId.' }
}
