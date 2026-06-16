import { describe, expect, it } from 'vitest'
import { extractScopeInfo } from '../../components/editor/QueryEditor'

describe('QueryEditor autocomplete scope', () => {
  it('includes UPDATE target tables for column completions', () => {
    const scope = extractScopeInfo('UPDATE users SET name = "Ada" WHERE id = 1')

    expect(scope.realTables).toContain('users')
  })

  it('keeps FROM and JOIN tables in scope', () => {
    const scope = extractScopeInfo('SELECT * FROM users u JOIN orders o ON o.user_id = u.id')

    expect(scope.realTables).toEqual(['users', 'orders'])
  })
})
