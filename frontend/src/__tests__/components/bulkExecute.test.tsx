import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { ScriptQueryResult, ScriptQueryValidationResult } from '../../types'
import {
  splitStatements,
  shouldTryFastExecute,
  formatScriptError,
  scriptResultToQueryResult,
} from '../../components/editor/TabContent'

describe('splitStatements', () => {
  it('splits semicolon-separated statements', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('handles statements without trailing semicolon', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('preserves semicolons inside single-quoted strings', () => {
    expect(splitStatements("INSERT INTO t (v) VALUES ('a;b')")).toEqual(["INSERT INTO t (v) VALUES ('a;b')"])
  })

  it('handles escaped single quotes', () => {
    expect(splitStatements("INSERT INTO t (v) VALUES ('O''Brien')")).toEqual(["INSERT INTO t (v) VALUES ('O''Brien')"])
  })

  it('preserves semicolons inside backtick identifiers', () => {
    expect(splitStatements('SELECT `a;b` FROM t')).toEqual(['SELECT `a;b` FROM t'])
  })

  it('skips empty statements', () => {
    expect(splitStatements('SELECT 1;; ; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('handles line comments', () => {
    expect(splitStatements('-- comment\nSELECT 1; SELECT 2')).toEqual(['-- comment\nSELECT 1', 'SELECT 2'])
  })

  it('handles block comments', () => {
    expect(splitStatements('/* comment */ SELECT 1')).toEqual(['/* comment */ SELECT 1'])
  })

  it('returns empty array for empty input', () => {
    expect(splitStatements('')).toEqual([])
    expect(splitStatements('   ')).toEqual([])
  })
})

describe('shouldTryFastExecute', () => {
  it('returns false for fewer than 25 statements', () => {
    const stmts = Array.from({ length: 24 }, (_, i) => `INSERT INTO t (id) VALUES (${i})`)
    expect(shouldTryFastExecute(stmts)).toBe(false)
  })

  it('returns true for 25+ INSERT statements', () => {
    const stmts = Array.from({ length: 25 }, (_, i) => `INSERT INTO t (id) VALUES (${i})`)
    expect(shouldTryFastExecute(stmts)).toBe(true)
  })

  it('returns true for 25+ UPDATE statements', () => {
    const stmts = Array.from({ length: 25 }, (_, i) => `UPDATE t SET x = ${i} WHERE id = ${i}`)
    expect(shouldTryFastExecute(stmts)).toBe(true)
  })

  it('returns true for 25+ DELETE statements', () => {
    const stmts = Array.from({ length: 25 }, (_, i) => `DELETE FROM t WHERE id = ${i}`)
    expect(shouldTryFastExecute(stmts)).toBe(true)
  })

  it('returns false for 25+ SELECT statements', () => {
    const stmts = Array.from({ length: 25 }, () => 'SELECT 1')
    expect(shouldTryFastExecute(stmts)).toBe(false)
  })

  it('handles leading comments before statement keyword', () => {
    const stmts = Array.from({ length: 25 }, (_, i) => `-- comment\nINSERT INTO t (id) VALUES (${i})`)
    expect(shouldTryFastExecute(stmts)).toBe(true)
  })

  it('returns false for 25+ total statements with fewer than 25 writes', () => {
    const stmts = [
      ...Array.from({ length: 26 }, () => 'SELECT 1'),
      'INSERT INTO t (id) VALUES (1)',
    ]
    expect(shouldTryFastExecute(stmts)).toBe(false)
  })

  it('returns true for 25+ writes mixed with other statements', () => {
    const stmts = [
      ...Array.from({ length: 25 }, (_, i) => `INSERT INTO t (id) VALUES (${i})`),
      'SELECT 1',
    ]
    expect(shouldTryFastExecute(stmts)).toBe(true)
  })

  it('handles hash comments before statement keyword', () => {
    const stmts = Array.from({ length: 25 }, (_, i) => `# comment\nINSERT INTO t (id) VALUES (${i})`)
    expect(shouldTryFastExecute(stmts)).toBe(true)
  })
})

describe('formatScriptError', () => {
  it('formats error with all fields', () => {
    const error = {
      code: 'MISSING_WHERE',
      problem: 'UPDATE needs WHERE',
      cause: 'Statement 1 has no WHERE',
      fix: 'Add WHERE clause',
      docs_url: '/docs/bulk-execution#missing-where',
    }
    const result = formatScriptError(error)
    expect(result).toBe('UPDATE needs WHERE\nStatement 1 has no WHERE\nAdd WHERE clause')
  })

  it('returns default for null error', () => {
    expect(formatScriptError(null)).toBe('Large write script failed')
  })

  it('returns default for undefined error', () => {
    expect(formatScriptError(undefined)).toBe('Large write script failed')
  })
})

describe('scriptResultToQueryResult', () => {
  it('converts successful result', () => {
    const input: ScriptQueryResult = {
      ok: true,
      execution_id: 'test-1',
      statements_executed: 100,
      affected_rows: 95,
      exec_time_ms: 123.45,
      rolled_back: false,
    }
    const result = scriptResultToQueryResult(input)
    expect(result.columns).toEqual(['Field', 'Value'])
    expect(result.row_count).toBe(4)
    expect(result.affected_rows).toBe(95)
    expect(result.exec_time_ms).toBe(123.45)
    expect(result.error).toBeUndefined()
    // Check specific rows
    expect(result.rows[0]).toEqual(['Statements executed', 100])
    expect(result.rows[1]).toEqual(['Affected rows', 95])
    expect(result.rows[2]).toEqual(['Elapsed', '123.45 ms'])
    expect(result.rows[3]).toEqual(['Transaction', 'Committed'])
  })

  it('converts rolled-back result', () => {
    const input: ScriptQueryResult = {
      ok: false,
      execution_id: 'test-2',
      statements_executed: 5,
      affected_rows: 3,
      exec_time_ms: 50,
      failed_statement_index: 5,
      failed_statement_preview: 'INSERT INTO bad_table',
      rolled_back: true,
      error: {
        code: 'SCRIPT_EXECUTION_FAILED',
        problem: 'Script failed',
        cause: 'Statement 6 failed',
        fix: 'Fix it',
        docs_url: '/docs/bulk-execution#script-execution-failed',
      },
    }
    const result = scriptResultToQueryResult(input)
    expect(result.rows[3]).toEqual(['Transaction', 'Rolled back'])
    expect(result.rows[4]).toEqual(['Failed statement', 6])
    expect(result.rows[5]).toEqual(['Failed preview', 'INSERT INTO bad_table'])
    expect(result.error).toBe('Script failed\nStatement 6 failed\nFix it')
  })
})

describe('BulkConfirmDialog', () => {
  it('renders with operation counts', async () => {
    const { default: BulkConfirmDialog } = await import('../../components/editor/BulkConfirmDialog')
    const { render, screen } = await import('@testing-library/react')
    const validation: ScriptQueryValidationResult = {
      ok: true,
      statement_count: 100,
      operation_counts: { INSERT: 70, UPDATE: 20, DELETE: 10 },
    }
    render(
      <BulkConfirmDialog
        open={true}
        validation={validation}
        database="app_db"
        statements={[
          'INSERT INTO users (id, name) VALUES (1, \'Ada\')',
          'UPDATE users SET name = \'Grace\' WHERE id = 1',
          'DELETE FROM users WHERE id = 2',
        ]}
        onConfirm={() => {}}
        onClose={() => {}}
      />
    )
    expect(screen.getByText('Review bulk write')).toBeTruthy()
    // Numbers and labels are in separate spans
    expect(screen.getByText('70')).toBeTruthy()
    expect(screen.getByText('INSERT')).toBeTruthy()
    expect(screen.getByText('20')).toBeTruthy()
    expect(screen.getByText('UPDATE')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
    expect(screen.getByText('DELETE')).toBeTruthy()
    expect(screen.getByText('app_db')).toBeTruthy()
    expect(screen.getByText(/1\. INSERT INTO users/)).toBeTruthy()
    expect(screen.getByText(/3\. DELETE FROM users/)).toBeTruthy()
  })
})

describe('BulkResultSummary', () => {
  it('renders committed status', async () => {
    const { default: BulkResultSummary } = await import('../../components/editor/BulkResultSummary')
    const { render, screen } = await import('@testing-library/react')
    const result: ScriptQueryResult = {
      ok: true,
      execution_id: 'test-1',
      statements_executed: 100,
      affected_rows: 95,
      exec_time_ms: 123.45,
      rolled_back: false,
    }
    render(<BulkResultSummary result={result} statements={[]} />)
    expect(screen.getByText('Committed')).toBeTruthy()
    expect(screen.getByText(/100 statements, 95 affected/)).toBeTruthy()
  })

  it('renders rolled back status', async () => {
    const { default: BulkResultSummary } = await import('../../components/editor/BulkResultSummary')
    const { render, screen } = await import('@testing-library/react')
    const result: ScriptQueryResult = {
      ok: false,
      execution_id: 'test-2',
      statements_executed: 5,
      affected_rows: 3,
      exec_time_ms: 50,
      rolled_back: true,
      error: {
        code: 'SCRIPT_EXECUTION_FAILED',
        problem: 'Script failed',
        cause: 'Statement 6 failed',
        fix: 'Fix it',
        docs_url: '/docs/bulk-execution#script-execution-failed',
      },
    }
    render(<BulkResultSummary result={result} statements={[]} />)
    expect(screen.getByText('Rolled back')).toBeTruthy()
    expect(screen.getByText('Script failed')).toBeTruthy()
  })

  it('renders unknown outcome status', async () => {
    const { default: BulkResultSummary } = await import('../../components/editor/BulkResultSummary')
    const { render, screen } = await import('@testing-library/react')
    const result: ScriptQueryResult = {
      ok: false,
      execution_id: 'test-unknown',
      statements_executed: 0,
      affected_rows: 0,
      exec_time_ms: 50,
      rolled_back: false,
      error: {
        code: 'OUTCOME_UNKNOWN',
        problem: 'Large write script outcome is unknown.',
        cause: 'Network failed',
        fix: 'Check rows before rerunning.',
        docs_url: '/docs/bulk-execution#outcome-unknown',
      },
    }
    render(<BulkResultSummary result={result} statements={[]} />)
    expect(screen.getByText('Outcome unknown')).toBeTruthy()
    expect(screen.getByText('Large write script outcome is unknown.')).toBeTruthy()
  })

  it('renders cancelled status', async () => {
    const { default: BulkResultSummary } = await import('../../components/editor/BulkResultSummary')
    const { render, screen } = await import('@testing-library/react')
    const result: ScriptQueryResult = {
      ok: false,
      execution_id: 'test-cancelled',
      statements_executed: 0,
      affected_rows: 0,
      exec_time_ms: 50,
      rolled_back: true,
      error: {
        code: 'CANCELLED_ROLLED_BACK',
        problem: 'Large write script was cancelled.',
        cause: 'Lagun sent a cancel request for this execution.',
        fix: 'Check target rows before rerunning if the connection dropped during cancellation.',
        docs_url: '/docs/bulk-execution#cancellation',
      },
    }
    render(<BulkResultSummary result={result} statements={[]} />)
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.getByText('Large write script was cancelled.')).toBeTruthy()
  })
})

describe('shared SQL classifier fixture alignment', () => {
  const fixturePath = resolve(__dirname, '../../../../tests/fixtures/sql_classifier.json')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'))

  const WRITE_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE']

  it('allowed statements have write-first-token alignment', () => {
    for (const { label, sql } of fixture.allowed) {
      const stmts = splitStatements(sql)
      const firstTokens = stmts.map(s => {
        const stripped = s.replace(/^\s*(?:--[^\n]*\n\s*)+/g, '').replace(/^\s*(?:#[^\n]*\n\s*)+/g, '').replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/g, '')
        return stripped.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? ''
      })
      const hasWrite = firstTokens.some(t => WRITE_KEYWORDS.includes(t))
      expect(hasWrite).toBe(true)
    }
  })

  it('threshold-sized rejected write fixtures still route to backend validation', () => {
    for (const { sql, expected_code } of fixture.rejected) {
      const stmts = splitStatements(sql)
      const token = stmts[0]?.replace(/^\s*(?:--[^\n]*\n\s*)+/g, '').replace(/^\s*(?:#[^\n]*\n\s*)+/g, '').replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)+/g, '').trim().match(/^[A-Za-z]+/)?.[0].toUpperCase()
      if (!['INSERT', 'UPDATE', 'DELETE'].includes(token ?? '')) continue
      const thresholdScript = Array.from({ length: 25 }, () => sql).join(';\n')
      expect(shouldTryFastExecute(splitStatements(thresholdScript)), expected_code).toBe(true)
    }
  })
})
