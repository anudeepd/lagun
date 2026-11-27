import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditColumnDialog from '../../components/table/EditColumnDialog'
import { api } from '../../api/client'
import { showToast } from '../../utils/toast'
import type { ColumnInfo } from '../../types'

vi.mock('../../api/client', () => ({
  api: {
    addColumn: vi.fn(),
    modifyColumn: vi.fn(),
  },
}))

vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }))

const addColumn = vi.mocked(api.addColumn)
const modifyColumn = vi.mocked(api.modifyColumn)

function makeColumn(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name: 'status',
    data_type: 'varchar',
    column_type: 'VARCHAR(255)',
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    is_auto_increment: false,
    extra: '',
    comment: '',
    ...overrides,
  }
}

const baseProps = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'app_db',
  table: 'users',
  mode: 'add' as const,
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole('button', { name: label }))
  await user.click(screen.getByRole('option', { name: option }))
}

describe('EditColumnDialog default restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['none', null, 'None', null],
    ['timestamp precision', 'CURRENT_TIMESTAMP(6)', 'CURRENT_TIMESTAMP(6)', null],
    ['wrapped timestamp', '(CURRENT_TIMESTAMP)', 'CURRENT_TIMESTAMP', null],
    ['empty function call', 'CURRENT_TIMESTAMP()', 'CURRENT_TIMESTAMP', null],
    ['curdate alias', 'curdate()', 'CURRENT_DATE', null],
    ['curtime alias', 'curtime()', 'CURRENT_TIME', null],
    ['localtimestamp alias', 'localtimestamp()', 'CURRENT_TIMESTAMP', null],
    ['localtime is literal', 'localtime()', 'Literal', 'localtime()'],
    ['trimmed rand', ' rand() ', 'RAND()', null],
    ['literal value', 'pending', 'Literal', 'pending'],
    ['date with arguments is literal', 'CURRENT_DATE(3)', 'Literal', 'CURRENT_DATE(3)'],
  ])('restores %s', (_label, stored, selected, literal) => {
    render(
      <EditColumnDialog
        {...baseProps}
        mode="modify"
        column={makeColumn({ column_default: stored as string | null })}
        onSaved={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Default' })).toHaveTextContent(selected)
    if (literal === null) {
      expect(screen.queryByRole('textbox', { name: 'Literal Value' })).not.toBeInTheDocument()
    } else {
      expect(screen.getByRole('textbox', { name: 'Literal Value' })).toHaveValue(literal)
    }
  })

  it('restores a custom type and missing comment, while a known type stays selected', async () => {
    const view = render(
      <EditColumnDialog
        {...baseProps}
        mode="modify"
        column={makeColumn({ column_type: 'ENUM("open","closed")', comment: undefined as unknown as string })}
        onSaved={vi.fn()}
      />,
    )

    expect(screen.getByRole('textbox', { name: 'Custom Type' })).toHaveValue('ENUM("open","closed")')
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('')

    view.rerender(
      <EditColumnDialog
        {...baseProps}
        mode="modify"
        column={makeColumn({ column_type: 'INT', is_nullable: false, comment: 'count' })}
        onSaved={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Type' })).toHaveTextContent('INT'))
    expect(screen.queryByRole('textbox', { name: 'Custom Type' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue('count')
  })
})

describe('EditColumnDialog validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requires a name, a type, and compatible defaults', async () => {
    const user = userEvent.setup()
    render(<EditColumnDialog {...baseProps} onSaved={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('Column name is required.')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'created_on')
    await choose(user, 'Type', 'Custom…')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('Column type is required.')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Custom Type' }), 'INT')
    await choose(user, 'Default', 'CURRENT_DATE')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('CURRENT_DATE default requires DATE.')).toBeInTheDocument()
    expect(addColumn).not.toHaveBeenCalled()
  })

  it.each([
    ['NULL', false, 'VARCHAR(255)', false, 'NULL default requires Nullable.'],
    ['CURRENT_TIMESTAMP', true, 'VARCHAR(255)', false, 'CURRENT_TIMESTAMP defaults require TIMESTAMP or DATETIME with matching precision.'],
    ['CURRENT_TIMESTAMP(3)', true, 'TIMESTAMP', false, 'CURRENT_TIMESTAMP defaults require TIMESTAMP or DATETIME with matching precision.'],
    ['CURRENT_DATE', true, 'VARCHAR(255)', false, 'CURRENT_DATE default requires DATE.'],
    ['CURRENT_TIME', true, 'INT', true, 'CURRENT_TIME default requires TIME.'],
    ['UUID()', true, 'INT', true, 'UUID() default requires CHAR, VARCHAR, or UUID.'],
    ['RAND()', true, 'VARCHAR(255)', false, 'RAND() default requires a numeric column.'],
    ['CURRENT_TIMESTAMP', true, '123', true, 'CURRENT_TIMESTAMP defaults require TIMESTAMP or DATETIME with matching precision.'],
  ])(
    'rejects %s for %s type %s',
    async (defaultMode, nullable, type, custom, expected) => {
      const user = userEvent.setup()
      render(<EditColumnDialog {...baseProps} onSaved={vi.fn()} />)

      await user.type(screen.getByRole('textbox', { name: 'Name' }), 'column_value')
      if (custom) {
        await choose(user, 'Type', 'Custom…')
        await user.type(screen.getByRole('textbox', { name: 'Custom Type' }), type)
      } else {
        await choose(user, 'Type', type)
      }
      await choose(user, 'Default', defaultMode)
      if (!nullable) {
        await user.click(screen.getByRole('checkbox', { name: 'Nullable' }))
      }
      await user.click(screen.getByRole('button', { name: 'Add' }))

      expect(screen.getByText(expected as string)).toBeInTheDocument()
      expect(addColumn).not.toHaveBeenCalled()
    },
  )
})

describe('EditColumnDialog save payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addColumn.mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
    modifyColumn.mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
  })

  it.each([
    ['CURRENT_TIMESTAMP', false, 'TIMESTAMP(0)', true, 'CURRENT_TIMESTAMP'],
    ['CURRENT_TIMESTAMP', false, 'DATETIME(0)', true, 'CURRENT_TIMESTAMP'],
    ['CURRENT_TIMESTAMP(3)', false, 'DATETIME(3)', true, 'CURRENT_TIMESTAMP(3)'],
    ['CURRENT_DATE', false, 'DATE', false, 'CURRENT_DATE'],
    ['CURRENT_TIME', false, 'TIME', true, 'CURRENT_TIME'],
    ['UUID()', false, 'CHAR(1)', true, 'UUID()'],
    ['UUID()', false, 'VARCHAR(255)', false, 'UUID()'],
    ['UUID()', false, 'UUID', true, 'UUID()'],
    ['RAND()', false, 'INT', true, 'RAND()'],
    ['NULL', false, 'VARCHAR(255)', false, 'NULL'],
  ])(
    'saves %s for %s type %s',
    async (defaultMode, _nullable, type, custom, expectedDefault) => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      render(<EditColumnDialog {...baseProps} onClose={onClose} onSaved={vi.fn()} />)

      await user.type(screen.getByRole('textbox', { name: 'Name' }), 'column_value')
      if (custom) {
        await choose(user, 'Type', 'Custom…')
        await user.type(screen.getByRole('textbox', { name: 'Custom Type' }), type)
      } else {
        await choose(user, 'Type', type)
      }
      await choose(user, 'Default', defaultMode)
      await user.click(screen.getByRole('button', { name: 'Add' }))

      await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
      expect(addColumn).toHaveBeenCalledWith('session-1', 'app_db', 'users', expect.objectContaining({
        name: 'column_value',
        type,
        default: expectedDefault,
      }))
      expect(showToast).toHaveBeenCalledWith('Column column_value added.', 'success')
    },
  )

  it('sends a literal default, comment, and nullable flag', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<EditColumnDialog {...baseProps} onClose={onClose} onSaved={vi.fn()} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '  status  ')
    await choose(user, 'Default', 'Literal')
    await user.type(screen.getByRole('textbox', { name: 'Literal Value' }), 'CURRENT_TIMESTAMP')
    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'current state')
    await user.click(screen.getByRole('checkbox', { name: 'Nullable' }))
    await user.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(addColumn).toHaveBeenCalledWith('session-1', 'app_db', 'users', {
      name: 'status',
      type: 'VARCHAR(255)',
      nullable: false,
      default: 'CURRENT_TIMESTAMP',
      default_is_literal: true,
      comment: 'current state',
    })
  })

  it('modifies the original column and reports a schema refresh failure', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <EditColumnDialog
        {...baseProps}
        mode="modify"
        column={makeColumn({ name: 'old_name' })}
        onClose={onClose}
        onSaved={vi.fn().mockRejectedValue(new Error('cache unavailable'))}
      />,
    )

    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'new_name')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(modifyColumn).toHaveBeenCalledWith(
      'session-1',
      'app_db',
      'users',
      'old_name',
      expect.objectContaining({ name: 'new_name', default: null }),
    )
    expect(showToast).toHaveBeenCalledWith(
      'Column new_name updated. Schema refresh failed: Error: cache unavailable',
      'error',
    )
  })

  it('renders the modify form without a column', () => {
    render(
      <EditColumnDialog
        {...baseProps}
        mode="modify"
        column={undefined}
        onSaved={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Edit Column: undefined' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('')
  })
})

describe('EditColumnDialog failures and stale requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    [new Error('alter denied'), 'Error: alter denied'],
    ['alter denied', 'alter denied'],
  ])('keeps an API failure visible', async (failure, expected) => {
    addColumn.mockRejectedValueOnce(failure)
    const user = userEvent.setup()
    render(<EditColumnDialog {...baseProps} onSaved={vi.fn()} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'status')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })

  it('does not close or toast after a close abandons the save', async () => {
    const gate = deferred<{ ok: boolean; sql: string }>()
    addColumn.mockImplementationOnce(() => gate.promise)
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSaved = vi.fn()
    const view = render(<EditColumnDialog {...baseProps} onClose={onClose} onSaved={onSaved} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'status')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    view.rerender(<EditColumnDialog {...baseProps} onClose={onClose} onSaved={onSaved} open={false} />)
    gate.resolve({ ok: true, sql: 'ALTER TABLE' })

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('ignores a stale API rejection and clears saving on reopen', async () => {
    const gate = deferred<{ ok: boolean; sql: string }>()
    addColumn.mockImplementationOnce(() => gate.promise)
    const user = userEvent.setup()
    const view = render(<EditColumnDialog {...baseProps} onSaved={vi.fn()} />)

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'status')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    view.rerender(<EditColumnDialog {...baseProps} onSaved={vi.fn()} open={false} />)
    gate.reject(new Error('late failure'))
    await Promise.resolve()
    view.rerender(<EditColumnDialog {...baseProps} onSaved={vi.fn()} />)

    expect(screen.queryByText(/late failure/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled()
  })
})
