import { describe, expect, it } from 'vitest'
import { errorMessageFromBody } from './client'

describe('errorMessageFromBody', () => {
  it('reports a gateway status instead of a proxy HTML page', () => {
    const body = [
      '<html>',
      '<head><title>502 Bad Gateway</title></head>',
      '<body><h1>502 Bad Gateway</h1>',
      'If the error message from server is less than 512 bytes IE v5+ will use its own error message.',
      '</body></html>',
    ].join('')

    expect(errorMessageFromBody(502, 'Bad Gateway', body)).toBe('HTTP 502 Bad Gateway')
  })

  it('reports a server status instead of a plain-text proxy page', () => {
    const body = 'IE friendly error message workaround. 502 Bad Gateway. The webserver reported an error.'

    expect(errorMessageFromBody(500, 'Internal Server Error', body)).toBe('HTTP 500 Internal Server Error')
  })

  it('keeps the detail from a JSON error body', () => {
    expect(errorMessageFromBody(503, 'Service Unavailable', JSON.stringify({ detail: 'No connection available' })))
      .toBe('No connection available')
  })
})
