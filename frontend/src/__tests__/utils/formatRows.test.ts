import { describe, expect, it } from 'vitest'
import { formatRowCount } from '../../utils/formatRows'

describe('formatRowCount', () => {
  it('uses the singular for exactly one row', () => {
    expect(formatRowCount(1)).toBe('1 row')
  })

  it('uses the plural otherwise, including zero', () => {
    expect(formatRowCount(0)).toBe('0 rows')
    expect(formatRowCount(4)).toBe('4 rows')
  })

  it('separates thousands so long counts stay readable', () => {
    expect(formatRowCount(1000)).toBe('1,000 rows')
  })
})
