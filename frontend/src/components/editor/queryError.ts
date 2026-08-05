export interface ParsedQueryError {
  code: string | null
  message: string
  raw: string
}

const MYSQL_TUPLE_ERROR = /^\((\d+),\s*(["'])([\s\S]*)\2\)$/
const MYSQL_PREFIX_ERROR = /^(?:ERROR\s+)?(\d+)(?:\s+\([^)]*\))?:\s*([\s\S]+)$/i

export function parseQueryError(error: string): ParsedQueryError {
  const raw = error.trim()
  const tuple = raw.match(MYSQL_TUPLE_ERROR)
  if (tuple) {
    return {
      code: tuple[1],
      message: tuple[3].replace(/\\(["'])/g, '$1').replace(/\\\\/g, '\\'),
      raw: error,
    }
  }

  const prefixed = raw.match(MYSQL_PREFIX_ERROR)
  if (prefixed) {
    return { code: prefixed[1], message: prefixed[2], raw: error }
  }

  return { code: null, message: error, raw: error }
}
