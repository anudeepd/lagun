import { describe, expect, it } from 'vitest'
import { parseQueryError } from '../../components/editor/queryError'

describe('parseQueryError edge behavior', () => {
  it('decodes escaped quotes and backslashes in tuple errors', () => {
    expect(parseQueryError('(1064, "You have an error \\"near x\\"")')).toEqual({
      code: '1064',
      message: 'You have an error "near x"',
      raw: '(1064, "You have an error \\"near x\\"")',
    })
    expect(parseQueryError("(1064, 'It\\\\s broken')")).toEqual({
      code: '1064',
      message: 'It\\s broken',
      raw: "(1064, 'It\\\\s broken')",
    })
  })

  it('parses ERROR-prefixed messages with optional SQLSTATE tuples', () => {
    expect(parseQueryError('  ERROR 1146 (42S02): Table does not exist  ')).toEqual({
      code: '1146',
      message: 'Table does not exist',
      raw: '  ERROR 1146 (42S02): Table does not exist  ',
    })
    expect(parseQueryError('123: Plain driver message')).toEqual({
      code: '123',
      message: 'Plain driver message',
      raw: '123: Plain driver message',
    })
  })

  it('rejects malformed prefixes instead of mislabeling the original error', () => {
    const cases = [
      'ERROR',
      'ERROR not-a-code: message',
      '123 (42S02: message without close',
      '123 message without colon',
      '123:    ',
      '123',
    ]
    for (const error of cases) {
      expect(parseQueryError(error)).toEqual({ code: null, message: error, raw: error })
    }
  })
})
