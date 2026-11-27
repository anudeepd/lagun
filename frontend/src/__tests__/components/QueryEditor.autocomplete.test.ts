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

  it('extracts subquery aliases through nested parentheses', () => {
    const scope = extractScopeInfo(
      'SELECT * FROM (SELECT COALESCE(price) AS total) AS totals',
    )

    expect(scope.subqueryAliases.get('totals')).toEqual(['total'])
  })

  it('does not end a subquery at a parenthesis inside a string', () => {
    const scope = extractScopeInfo(
      "SELECT * FROM (SELECT ')' AS label) AS filtered",
    )

    expect(scope.subqueryAliases.get('filtered')).toEqual(['label'])
  })
})
