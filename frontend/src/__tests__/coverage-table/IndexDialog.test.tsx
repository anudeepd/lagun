import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import IndexDialog from '../../components/table/IndexDialog'
import { api } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: {
    createIndex: vi.fn(),
  },
}))

const createIndex = vi.mocked(api.createIndex)

const props = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'app_db',
  table: 'users',
  columns: ['id', 'email'],
}

describe('IndexDialog behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createIndex.mockResolvedValue({ ok: true, sql: 'CREATE INDEX' })
  })

  it('requires a name and at least one column', async () => {
    const user = userEvent.setup()
    render(<IndexDialog {...props} />)

    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Name and at least one column are required.')).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: 'Index Name' }), 'idx_email')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(screen.getByText('Name and at least one column are required.')).toBeInTheDocument()
    expect(createIndex).not.toHaveBeenCalled()
  })

  it('toggles columns and sends the selected index options', async () => {
    const user = userEvent.setup()
    render(<IndexDialog {...props} />)

    await user.type(screen.getByRole('textbox', { name: 'Index Name' }), 'idx_email')
    await user.click(screen.getByRole('button', { name: 'email' }))
    await user.click(screen.getByRole('button', { name: 'id' }))
    await user.click(screen.getByRole('button', { name: 'id' }))
    await user.click(screen.getByRole('checkbox', { name: 'Unique' }))
    await user.click(screen.getByRole('button', { name: 'Index Type' }))
    await user.click(screen.getByRole('option', { name: 'HASH' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce())
    expect(createIndex).toHaveBeenCalledWith('session-1', 'app_db', 'users', {
      name: 'idx_email',
      columns: ['email'],
      unique: true,
      index_type: 'HASH',
    })
  })

  it.each([
    [new Error('permission denied'), 'Error: permission denied'],
    ['backend unavailable', 'backend unavailable'],
  ])('surfaces a failed create request', async (failure, expected) => {
    createIndex.mockRejectedValueOnce(failure)
    const user = userEvent.setup()
    render(<IndexDialog {...props} />)

    await user.type(screen.getByRole('textbox', { name: 'Index Name' }), 'idx_id')
    await user.click(screen.getByRole('button', { name: 'id' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })
})
