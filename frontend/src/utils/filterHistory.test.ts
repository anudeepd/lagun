import { describe, it, expect, beforeEach } from 'vitest'
import { loadFilterHistory, recordFilterHistory, FILTER_HISTORY_LIMIT } from './filterHistory'

describe('filterHistory', () => {
  beforeEach(() => localStorage.clear())

  it('starts empty for unknown tables', () => {
    expect(loadFilterHistory('db', 'users')).toEqual([])
    expect(loadFilterHistory(undefined, undefined)).toEqual([])
  })

  it('records newest first and persists across reads', () => {
    recordFilterHistory('db', 'users', 'id = 5')
    recordFilterHistory('db', 'users', "name LIKE 'John%'")
    expect(loadFilterHistory('db', 'users')).toEqual(["name LIKE 'John%'", 'id = 5'])
    // Other tables unaffected.
    expect(loadFilterHistory('db', 'orders')).toEqual([])
  })

  it('dedupes by moving the re-applied filter to the front', () => {
    recordFilterHistory('db', 'users', 'id = 5')
    recordFilterHistory('db', 'users', 'price > 10')
    recordFilterHistory('db', 'users', 'id = 5')
    expect(loadFilterHistory('db', 'users')).toEqual(['id = 5', 'price > 10'])
  })

  it('caps history at the limit', () => {
    for (let i = 0; i < FILTER_HISTORY_LIMIT + 5; i++) {
      recordFilterHistory('db', 'users', `id = ${i}`)
    }
    const history = loadFilterHistory('db', 'users')
    expect(history).toHaveLength(FILTER_HISTORY_LIMIT)
    expect(history[0]).toBe(`id = ${FILTER_HISTORY_LIMIT + 4}`)
  })

  it('trims and ignores blank filters', () => {
    recordFilterHistory('db', 'users', '  id = 5  ')
    expect(loadFilterHistory('db', 'users')).toEqual(['id = 5'])
    recordFilterHistory('db', 'users', '   ')
    expect(loadFilterHistory('db', 'users')).toEqual(['id = 5'])
  })
})
