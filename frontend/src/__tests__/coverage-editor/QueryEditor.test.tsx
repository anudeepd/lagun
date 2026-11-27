import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import QueryEditor, {
  extractScopeInfo,
  extractStatementAt,
  isInColumnContext,
} from '../../components/editor/QueryEditor'

const captured = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}))
const platform = vi.hoisted(() => ({ isMac: false }))

vi.mock('../../utils/platform', () => ({
  get isMac() { return platform.isMac },
  get modKey() { return platform.isMac ? '⌘' : 'Ctrl' },
}))

vi.mock('@uiw/react-codemirror', async () => {
  const React = await import('react')
  return {
    default: React.forwardRef(function MockCodeMirror(
      props: Record<string, unknown>,
      ref: React.ForwardedRef<{ view: { requestMeasure: () => void } }>,
    ) {
      captured.props = props
      React.useImperativeHandle(ref, () => ({ view: { requestMeasure: vi.fn() } }))
      return React.createElement('div', { 'data-testid': 'query-code-mirror' })
    }),
  }
})

function editorExtensions(): unknown[] {
  return (captured.props?.extensions ?? []) as unknown[]
}

function completionResults(doc: string, explicit = false, pos = doc.length): CompletionResult[] {
  const state = EditorState.create({ doc, extensions: editorExtensions() as never[] })
  const context = new CompletionContext(state, pos, explicit)
  const providers = state.languageDataAt<(ctx: CompletionContext) => CompletionResult | null>(
    'autocomplete',
    pos,
  )
  return providers
    .map(provider => provider(context))
    .filter((result): result is CompletionResult => result !== null)
}

function runKeymapShortcut() {
  const state = EditorState.create({ doc: '', extensions: editorExtensions() as never[] })
  const binding = state.facet(keymap).flat().find(item => item.key === 'Ctrl-Enter')
  if (!binding) throw new Error('Ctrl-Enter keymap not registered')
  return binding.run?.({} as never)
}

function renderEditor(props: Partial<React.ComponentProps<typeof QueryEditor>> = {}) {
  const defaults: React.ComponentProps<typeof QueryEditor> = {
    value: 'SELECT 1',
    onChange: vi.fn(),
    onRun: vi.fn(),
    running: false,
  }
  return render(<QueryEditor {...defaults} {...props} />)
}

describe('QueryEditor SQL scope helpers', () => {
  beforeEach(() => {
    platform.isMac = false
  })

  it('extracts the statement around a cursor', () => {
    expect(extractStatementAt('SELECT 1; SELECT 2', 18)).toBe(' SELECT 2')
    expect(extractStatementAt('SELECT 1; SELECT 2', 9)).toBe(' SELECT 2')
    expect(extractStatementAt('SELECT 1', 0)).toBe('SELECT 1')
    expect(extractStatementAt('SELECT 1;', 9)).toBe('')
  })

  it('finds real tables and deduplicates them', () => {
    expect(
      extractScopeInfo('SELECT * FROM `app`.`users` u JOIN orders o ON o.user_id = u.id UPDATE archive SET x = 1').realTables,
    ).toEqual(['users', 'orders', 'archive'])
    expect(extractScopeInfo('SELECT * FROM users u, orders o').realTables).toEqual(['users'])
  })

  it('handles subqueries with nested parens, quotes, escaped quotes, and aliases', () => {
    const nested = extractScopeInfo('SELECT * FROM (SELECT COALESCE((price)) AS total) AS totals')
    expect(nested.subqueryAliases.get('totals')).toEqual(['total'])

    const escaped = extractScopeInfo("SELECT * FROM (SELECT 'a\\'b' AS label) AS filtered")
    expect(escaped.subqueryAliases.get('filtered')).toEqual(['label'])

    const doubled = extractScopeInfo("SELECT * FROM (SELECT \"a)b\" AS label) AS filtered")
    expect(doubled.subqueryAliases.get('filtered')).toEqual(['label'])

    const escapedDoubled = extractScopeInfo("SELECT * FROM (SELECT 'a''b' AS label) AS filtered")
    expect(escapedDoubled.subqueryAliases.get('filtered')).toEqual(['label'])

    const backtick = extractScopeInfo('SELECT * FROM (SELECT `a\\b` AS label) AS filtered')
    expect(backtick.subqueryAliases.get('filtered')).toEqual(['label'])
  })

  it('retains bare identifiers, aliases, and filters SQL keywords and blanks', () => {
    const scope = extractScopeInfo(
      'SELECT * FROM (SELECT price AS total, user_id, $price, COUNT(*), , 1 + 2 AS calc, WHERE) AS t',
    )
    expect(scope.subqueryAliases.get('t')).toEqual(['total', 'user_id', '$price', 'calc'])
  })

  it('skips unclosed subqueries, unaliased subqueries, and aliases with no columns', () => {
    expect(extractScopeInfo('SELECT * FROM (SELECT id').subqueryAliases.size).toBe(0)
    expect(extractScopeInfo('SELECT * FROM (SELECT id)').subqueryAliases.size).toBe(0)
    expect(extractScopeInfo('SELECT * FROM (SELECT WHERE) AS empty').subqueryAliases.size).toBe(0)
    expect(
      extractScopeInfo("SELECT * FROM (SELECT 'unterminated) AS broken").subqueryAliases.size,
    ).toBe(0)
  })

  it('distinguishes column contexts from table-name contexts', () => {
    expect(isInColumnContext('SELECT * FROM users WHERE na')).toBe(true)
    expect(isInColumnContext('SELECT u.')).toBe(false)
    expect(isInColumnContext('SELECT * FROM us')).toBe(false)
    expect(isInColumnContext('SELECT * FROM app.us')).toBe(false)
    expect(isInColumnContext('UPDATE us')).toBe(false)
    expect(isInColumnContext('INSERT INTO us')).toBe(false)
    expect(isInColumnContext('TABLE us')).toBe(false)
    expect(isInColumnContext('JOIN us')).toBe(false)
  })
})

describe('QueryEditor completion providers', () => {
  it('offers user-defined and built-in functions only when useful', () => {
    renderEditor({ functions: ['MY_FUNC'] })
    const wordResults = completionResults('SELECT CO')
    expect(wordResults.flatMap(result => result.options).map(option => option.label)).toContain('MY_FUNC')

    const implicitEmpty = completionResults('SELECT ')
    expect(
      implicitEmpty.flatMap(result => result.options).some(option => option.label === 'ABS'),
    ).toBe(false)

    const explicitEmpty = completionResults('SELECT ', true)
    const builtins = explicitEmpty.flatMap(result => result.options)
    expect(builtins.some(option => option.label === 'ABS')).toBe(true)
    expect(explicitEmpty.some(result => result.from === 7)).toBe(true)
  })

  it('offers unique and table-qualified columns from the current statement scope', () => {
    renderEditor({
      schema: { users: ['id', 'name'], orders: ['id', 'status'] },
    })
    const results = completionResults(
      'SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE na',
    )
    const properties = results.flatMap(result => result.options).filter(option => option.type === 'property')
    expect(properties.map(option => option.label)).toContain('name')
    expect(properties.find(option => option.label === 'name')?.detail).toBe('users')

    const ambiguous = completionResults(
      'SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE i',
    )
    const labels = ambiguous.flatMap(result => result.options).map(option => option.label)
    expect(labels).toContain('users.id')
    expect(labels).toContain('orders.id')

    const missingSchema = completionResults('SELECT * FROM missing WHERE i')
    expect(
      missingSchema.flatMap(result => result.options).some(option => option.type === 'property'),
    ).toBe(false)
  })

  it('offers subquery alias columns and explicit empty-word completions', () => {
    renderEditor({
      schema: { users: ['id', 'name'] },
    })
    const doc = 'SELECT * FROM users u JOIN (SELECT name AS label) AS sq ON 1 WHERE la'
    const subquery = completionResults(doc)
    const labels = subquery.flatMap(result => result.options).filter(option => option.type === 'property')
    expect(labels.map(option => option.label)).toContain('label')
    expect(labels.find(option => option.label === 'label')?.detail).toBe('sq')

    const duplicate = completionResults(
      'SELECT * FROM users u JOIN (SELECT id) AS sq ON 1 WHERE i',
    )
    expect(
      duplicate.flatMap(result => result.options).map(option => option.label),
    ).toContain('sq.id')

    const explicitDoc = 'SELECT * FROM users WHERE '
    const explicitAtEnd = completionResults(explicitDoc, true)
    expect(explicitAtEnd.some(result => result.from === explicitDoc.length)).toBe(true)
    expect(
      explicitAtEnd.flatMap(result => result.options).some(option => option.type === 'property'),
    ).toBe(true)
  })

  it('does not offer column completions with no word, no scope, a dot, or a table context', () => {
    renderEditor({ schema: { users: ['id'] } })
    for (const [doc, explicit] of [
      ['SELECT * FROM users WHERE ', false],
      ['SELECT ', false],
      ['SELECT u.', false],
      ['SELECT * FROM us', false],
    ] as const) {
      const results = completionResults(doc, explicit)
      expect(
        results.flatMap(result => result.options).some(option => option.type === 'property'),
      ).toBe(false)
    }
  })
})

describe('QueryEditor chrome behavior', () => {
  it('warns when no database is selected and disables an empty run', () => {
    renderEditor({ value: '' })
    expect(screen.getByRole('status')).toHaveTextContent('Select a database for table queries')
    expect(screen.getByRole('button', { name: /Run/ })).toBeDisabled()
  })

  it('offers a database picker with a disabled placeholder when no database is selected', () => {
    renderEditor({ databases: ['app_db'], database: undefined })
    const picker = screen.getByLabelText('Database')
    expect(picker).toHaveTextContent('Select database…')
    expect(screen.getByRole('status')).toHaveTextContent('Select a database for table queries')
  })

  it('shows a read-only database label when no list is available', () => {
    renderEditor({ database: 'app_db' })
    expect(screen.getByText('app_db')).toBeInTheDocument()
    expect(screen.queryByLabelText('Database')).not.toBeInTheDocument()
  })

  it('drives database, run, cancel, limit, and word-wrap actions', () => {
    const onDatabaseChange = vi.fn()
    const onRun = vi.fn()
    const onCancel = vi.fn()
    const onLimitChange = vi.fn()
    const onWordWrapChange = vi.fn()
    const onChange = vi.fn()
    renderEditor({
      value: 'SELECT 1',
      onChange,
      onDatabaseChange,
      onRun,
      onCancel,
      onLimitChange,
      onWordWrapChange,
      databases: ['app_db', 'analytics'],
      database: 'app_db',
      limit: 1000,
      running: true,
      wordWrap: true,
    })

    fireEvent.click(screen.getByLabelText('Database'))
    fireEvent.click(screen.getByRole('option', { name: 'analytics' }))
    expect(onDatabaseChange).toHaveBeenCalledWith('analytics')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: /Run/ })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Row limit' }))
    fireEvent.click(screen.getByRole('option', { name: '500' }))
    expect(onLimitChange).toHaveBeenCalledWith(500)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle word wrap' }))
    expect(onWordWrapChange).toHaveBeenCalledWith(false)

    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect(onRun).not.toHaveBeenCalled()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('enables Run for non-empty SQL and hides optional controls when callbacks are absent', () => {
    const onRun = vi.fn()
    const { rerender } = renderEditor({ value: 'SELECT 1', onRun })
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Toggle word wrap' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Row limit' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect(onRun).toHaveBeenCalledOnce()

    rerender(
      <QueryEditor
        value=""
        onChange={vi.fn()}
        onRun={onRun}
        running={false}
        wordWrap={false}
        onWordWrapChange={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Run/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Toggle word wrap' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('uses the editor ref and default word wrap without requiring optional props', () => {
    const editorRef = { current: null } as React.MutableRefObject<never>
    renderEditor({ editorRef })
    expect(screen.getByTestId('query-code-mirror')).toBeInTheDocument()
    expect(editorExtensions().length).toBeGreaterThan(0)
  })

  it('runs the editor shortcut only when not already running', () => {
    const onRun = vi.fn()
    const { rerender } = renderEditor({ onRun, running: true })
    expect(runKeymapShortcut()).toBe(true)
    expect(onRun).not.toHaveBeenCalled()

    rerender(<QueryEditor value="SELECT 1" onChange={vi.fn()} onRun={onRun} running={false} />)
    expect(runKeymapShortcut()).toBe(true)
    expect(onRun).toHaveBeenCalledOnce()
  })

  it('shows the platform-specific run shortcut', () => {
    const { rerender } = renderEditor()
    expect(screen.getByText('Ctrl+↵')).toBeInTheDocument()

    platform.isMac = true
    rerender(<QueryEditor value="SELECT 1" onChange={vi.fn()} onRun={vi.fn()} running={false} />)
    expect(screen.getByText('⌘↵')).toBeInTheDocument()
  })
})
