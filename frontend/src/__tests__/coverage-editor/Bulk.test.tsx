import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BulkConfirmDialog from '../../components/editor/BulkConfirmDialog'
import BulkResultSummary from '../../components/editor/BulkResultSummary'
import type { ScriptQueryResult, ScriptQueryValidationResult } from '../../types'

function validation(overrides: Partial<ScriptQueryValidationResult> = {}): ScriptQueryValidationResult {
  return {
    ok: true,
    statement_count: 1,
    operation_counts: { INSERT: 1 },
    ...overrides,
  }
}

function scriptResult(overrides: Partial<ScriptQueryResult> = {}): ScriptQueryResult {
  return {
    ok: true,
    execution_id: 'exec-1',
    statements_executed: 1,
    affected_rows: 1,
    exec_time_ms: 4,
    rolled_back: false,
    ...overrides,
  }
}

describe('BulkConfirmDialog behavior', () => {
  it('stays closed when open is false', () => {
    render(
      <BulkConfirmDialog
        open={false}
        statements={[]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('previews an INSERT-only script, handles defaults, and confirms directly', async () => {
    const onConfirm = vi.fn()
    render(
      <BulkConfirmDialog
        open
        validation={validation({ statement_count: 2, operation_counts: { INSERT: 2 } })}
        statements={['INSERT INTO users VALUES (1)', 'INSERT INTO users VALUES (2)']}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByRole('dialog', { name: 'Review bulk write' })).toBeInTheDocument()
    expect(screen.getAllByText((_, element) => element?.textContent === '2 INSERT').length).toBeGreaterThan(0)
    expect(screen.getByText('selected connection default')).toBeInTheDocument()
    expect(screen.getByText('INSERT-only script. Runs in one transaction and rolls back on first failure.')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run 2 inserts' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('uses zero counts and no statement preview when the caller has only defaults', async () => {
    render(
      <BulkConfirmDialog
        open
        validation={undefined}
        statements={[]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run 0 inserts' })).toBeInTheDocument()
    expect(screen.queryByText('Statement preview')).not.toBeInTheDocument()
    expect(screen.queryByText('INSERT')).not.toBeInTheDocument()
    expect(screen.queryByText('UPDATE')).not.toBeInTheDocument()
    expect(screen.queryByText('DELETE')).not.toBeInTheDocument()
  })

  it('requires acknowledgement for writes, truncates long previews, and resets on reopen', async () => {
    const longStatement = `UPDATE users SET name = '${'x'.repeat(200)}'`
    const statements = [longStatement, 'DELETE FROM users WHERE id = 1', 'UPDATE users SET name = \'Bob\' WHERE id = 2']
    const { rerender } = render(
      <BulkConfirmDialog
        open
        validation={validation({
          statement_count: 70,
          operation_counts: { INSERT: 20, UPDATE: 20, DELETE: 10 },
        })}
        database="app_db"
        statements={statements}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const destructive = await screen.findByRole('button', { name: 'Run 70 writes (destructive)' })
    expect(destructive).toBeDisabled()
    expect(screen.getByText('app_db')).toBeInTheDocument()
    expect(screen.getByText("…")).toBeInTheDocument()
    expect(screen.getByText(/1\. UPDATE users SET name/)).toHaveTextContent('…')
    expect(screen.getByText(/3\. UPDATE users SET name = 'Bob'/)).toBeInTheDocument()

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)
    expect(destructive).toBeEnabled()

    rerender(
      <BulkConfirmDialog
        open={false}
        validation={validation({
          statement_count: 70,
          operation_counts: { INSERT: 20, UPDATE: 20, DELETE: 10 },
        })}
        database="app_db"
        statements={statements}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    rerender(
      <BulkConfirmDialog
        open
        validation={validation({
          statement_count: 70,
          operation_counts: { INSERT: 20, UPDATE: 20, DELETE: 10 },
        })}
        database="app_db"
        statements={statements}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run 70 writes (destructive)' })).toBeDisabled())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
  })

  it('invokes close from Cancel and the modal close button', async () => {
    const onClose = vi.fn()
    render(
      <BulkConfirmDialog
        open
        validation={validation()}
        statements={['INSERT INTO users VALUES (1)']}
        onConfirm={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('BulkResultSummary behavior', () => {
  it('shows a committed summary and expands/collapses details', async () => {
    const result = scriptResult({
      statements_executed: 5,
      affected_rows: 5,
      failed_statement_index: 0,
      failed_statement_preview: 'UPDATE doomed',
      error: {
        code: 'SQL_ERROR',
        problem: 'Second statement failed',
        cause: 'Constraint violation',
        fix: 'Fix the row first',
        docs_url: '/docs/bulk',
      },
    })
    const statements = ['INSERT INTO users VALUES (1)', 'UPDATE users SET name = \'A\'', 'DELETE FROM users WHERE id = 3', 'UPDATE users SET name = \'B\'', 'SELECT 1']
    render(<BulkResultSummary result={result} statements={statements} />)

    expect(screen.getByText('Committed')).toBeInTheDocument()
    expect(screen.getByText('Second statement failed')).toHaveAttribute('title', 'Fix the row first')
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Failed at:')).toBeInTheDocument()
    expect(screen.getByText('statement 1')).toBeInTheDocument()
    expect(screen.getByText('Failed statement:')).toBeInTheDocument()
    expect(screen.getByText('SQL_ERROR')).toBeInTheDocument()
    expect(screen.getByText('Fix the row first')).toBeInTheDocument()
    expect(screen.getByText('First statements:')).toBeInTheDocument()
    expect(screen.getByText('Last executed statements:')).toBeInTheDocument()
    expect(screen.getByText('5. SELECT 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    await waitFor(() => expect(screen.queryByText('First statements:')).not.toBeInTheDocument())
  })

  it('renders cancelled, outcome-unknown, rolled-back, and not-committed states with their details', () => {
    const error = (code: string) => ({
      code,
      problem: `${code} problem`,
      cause: `${code} cause`,
      fix: `${code} fix`,
      docs_url: '/docs',
    })
    const { rerender } = render(
      <BulkResultSummary
        result={scriptResult({ ok: false, rolled_back: true, error: error('CANCELLED_ROLLED_BACK') })}
        statements={[]}
      />,
    )
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('CANCELLED_ROLLED_BACK problem')).toBeInTheDocument()

    rerender(
      <BulkResultSummary
        result={scriptResult({ ok: false, error: error('OUTCOME_UNKNOWN') })}
        statements={[]}
      />,
    )
    expect(screen.getByText('Outcome unknown')).toBeInTheDocument()

    rerender(
      <BulkResultSummary
        result={scriptResult({ ok: false, rolled_back: true })}
        statements={[]}
      />,
    )
    expect(screen.getByText('Rolled back')).toBeInTheDocument()

    rerender(
      <BulkResultSummary
        result={scriptResult({ ok: false, rolled_back: false })}
        statements={[]}
      />,
    )
    expect(screen.getByText('Not committed')).toBeInTheDocument()
  })

  it('renders rolled-back and truncation details, filtering last statements beyond the script length', async () => {
    const long = `x${'y'.repeat(170)}`
    const result = scriptResult({
      ok: false,
      rolled_back: true,
      statements_executed: 6,
      failed_statement_index: 5,
      failed_statement_preview: long,
    })
    render(
      <BulkResultSummary
        result={result}
        statements={[long, 'SELECT 2', 'SELECT 3', 'SELECT 4']}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('rolled back')).toBeInTheDocument()
    expect(screen.getByText('statement 6')).toBeInTheDocument()
    expect(screen.getAllByText(new RegExp(`${long.slice(0, 100)}`)).length).toBeGreaterThan(0)
    expect(screen.getByText('Last executed statements:')).toBeInTheDocument()
    expect(screen.getByText('4. SELECT 4')).toBeInTheDocument()
    expect(screen.queryByText('5. undefined')).not.toBeInTheDocument()
  })

  it('omits last executed statements when the script is short', async () => {
    render(
      <BulkResultSummary
        result={scriptResult({ statements_executed: 2 })}
        statements={['INSERT INTO a VALUES (1)', 'INSERT INTO a VALUES (2)']}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('First statements:')).toBeInTheDocument()
    expect(screen.queryByText('Last executed statements:')).not.toBeInTheDocument()
  })
})
