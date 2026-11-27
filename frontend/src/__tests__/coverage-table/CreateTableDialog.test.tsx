import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CreateTableDialog from '../../components/table/CreateTableDialog'
import { api } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: {
    createTable: vi.fn(),
  },
}))

const createTable = vi.mocked(api.createTable)

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const props = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'app_db',
  onCreated: vi.fn(),
}

describe('CreateTableDialog behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createTable.mockResolvedValue({ ok: true, sql: 'CREATE TABLE' })
  })

  it('edits and removes column definitions before creating the table', async () => {
    const user = userEvent.setup()
    render(<CreateTableDialog {...props} />)

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    await user.click(screen.getByRole('button', { name: /Add Column/ }))
    await user.type(screen.getAllByPlaceholderText('column_name')[1], 'name')
    await user.click(screen.getByRole('button', { name: 'Type for column 2' }))
    await user.click(screen.getByRole('option', { name: 'TEXT' }))

    const checkboxes = screen.getAllByRole('checkbox')
    await user.click(checkboxes[3])
    await user.click(checkboxes[4])
    await user.click(checkboxes[5])
    await user.click(screen.getByRole('button', { name: 'Engine' }))
    await user.click(screen.getByRole('option', { name: 'MyISAM' }))
    await user.click(screen.getByRole('button', { name: 'Remove column 2' }))
    await user.click(screen.getByRole('button', { name: /Add Column/ }))
    await user.type(screen.getAllByPlaceholderText('column_name')[1], 'body')

    await user.click(screen.getByRole('button', { name: 'Create Table' }))

    await waitFor(() => expect(props.onCreated).toHaveBeenCalledOnce())
    expect(createTable).toHaveBeenCalledWith('session-1', 'app_db', {
      name: 'widgets',
      columns: [
        { name: 'id', type: 'INT', nullable: false, primary_key: true, auto_increment: true },
        { name: 'body', type: 'VARCHAR(255)', nullable: true, primary_key: false, auto_increment: false },
      ],
      engine: 'MyISAM',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('validates the table and every column name', async () => {
    const user = userEvent.setup()
    render(<CreateTableDialog {...props} />)

    await user.click(screen.getByRole('button', { name: 'Create Table' }))
    expect(screen.getByText('Table name required')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    fireEvent.change(screen.getAllByPlaceholderText('column_name')[0], { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Create Table' }))

    expect(screen.getByText('All columns need a name')).toBeInTheDocument()
    expect(createTable).not.toHaveBeenCalled()
  })

  it('keeps a failed create visible and re-enables submit', async () => {
    createTable.mockRejectedValueOnce(new Error('duplicate table'))
    const user = userEvent.setup()
    render(<CreateTableDialog {...props} />)

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    await user.click(screen.getByRole('button', { name: 'Create Table' }))

    expect(await screen.findByText('Error: duplicate table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Table' })).toBeEnabled()
    expect(props.onCreated).not.toHaveBeenCalled()
  })

  it('resets when reopened and ignores a stale rejection', async () => {
    const gate = deferred<{ ok: boolean; sql: string }>()
    createTable.mockImplementationOnce(() => gate.promise)
    const user = userEvent.setup()
    const onClose = vi.fn()
    const view = render(
      <CreateTableDialog {...props} onClose={onClose} />,
    )

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    await user.click(screen.getByRole('button', { name: 'Create Table' }))
    view.rerender(<CreateTableDialog {...props} onClose={onClose} open={false} />)
    gate.reject(new Error('late failure'))
    await Promise.resolve()

    view.rerender(<CreateTableDialog {...props} onClose={onClose} />)
    expect(screen.getByLabelText('Table Name')).toHaveValue('')
    expect(screen.queryByText(/late failure/)).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('refreshes after a stale success without closing a reopened dialog', async () => {
    const gate = deferred<{ ok: boolean; sql: string }>()
    createTable.mockImplementationOnce(() => gate.promise)
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreated = vi.fn()
    const view = render(
      <CreateTableDialog {...props} onClose={onClose} onCreated={onCreated} />,
    )

    await user.type(screen.getByLabelText('Table Name'), 'widgets')
    await user.click(screen.getByRole('button', { name: 'Create Table' }))
    view.rerender(<CreateTableDialog {...props} onClose={onClose} onCreated={onCreated} open={false} />)
    gate.resolve({ ok: true, sql: 'CREATE TABLE' })

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(onClose).not.toHaveBeenCalled()
  })
})
