export interface ParsedQueryError {
  code: string | null
  message: string
  raw: string
}

const MYSQL_TUPLE_ERROR = /^\((\d+),\s*(["'])([\s\S]*)\2\)$/

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

  const prefixed = parsePrefixedError(raw)
  if (prefixed) {
    return { code: prefixed.code, message: prefixed.message, raw: error }
  }

  return { code: null, message: error, raw: error }
}

function parsePrefixedError(value: string): { code: string; message: string } | null {
  let rest = value
  if (rest.slice(0, 5).toUpperCase() === 'ERROR' && isWhitespace(rest[5])) {
    rest = rest.slice(5).trimStart()
  }
  let codeEnd = 0
  while (codeEnd < rest.length) {
    const code = rest.charCodeAt(codeEnd)
    if (code < 48 || code > 57) break
    codeEnd++
  }
  if (codeEnd === 0) return null
  let index = codeEnd
  if (isWhitespace(rest[index]) && rest[index + 1] === '(') {
    const close = rest.indexOf(')', index + 2)
    if (close < 0) return null
    index = close + 1
  }
  if (rest[index] !== ':') return null
  let messageStart = index + 1
  while (messageStart < rest.length && isWhitespace(rest[messageStart])) messageStart++
  if (messageStart >= rest.length) return null
  return { code: rest.slice(0, codeEnd), message: rest.slice(messageStart) }
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && char.trim() === ''
}
