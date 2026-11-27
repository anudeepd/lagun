import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PrimaryKeyDialog from '../../components/table/PrimaryKeyDialog'
import { api } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: {
    setPrimaryKey: vi.fn(),
    dropPrimaryKey: vi.fn(),
  },
}))

const setPrimaryKey = vi.mocked(api.setPrimaryKey)
const dropPrimaryKey = vi.mocked(api.dropPrimaryKey)
const columns = ['id', 'tenant_id', 'email', 'status']

function renderDialog(currentPkColumns: string[], onClose = vi.fn()) {
  return (
    <PrimaryKeyDialog
      open
      onClose={onClose}
      sessionId="session-1"
      database="app_db"
      table="users"
      columns={columns}
      currentPkColumns={currentPkColumns}
    />
  )
}

function checked(name: string) {
  return screen.getByRole('button', { name }).className.includes('bg-brand-600')
}

describe('PrimaryKeyDialog behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPrimaryKey.mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
    dropPrimaryKey.mockResolvedValue({ ok: true, sql: 'ALTER TABLE' })
  })

  it('resets from the live key when reopened and toggles a selection', async () => {
    const user = userEvent.setup()
    const view = render(renderDialog(['id', 'tenant_id']))

    expect(checked('id')).toBe(true)
    expect(checked('tenant_id')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'id' }))
    expect(checked('id')).toBe(false)

    view.rerender(renderDialog([]))
    await waitFor(() => expect(columns.some(col => checked(col))).toBe(false))
    expect(screen.queryByRole('button', { name: 'Drop PK' })).not.toBeInTheDocument()

    view.rerender(
      <PrimaryKeyDialog
        open={false}
        onClose={vi.fn()}
        sessionId="session-1"
        database="app_db"
        table="users"
        columns={columns}
        currentPkColumns={['email']}
      />,
    )
    view.rerender(renderDialog(['email', 'status']))

    await waitFor(() => expect(checked('email')).toBe(true))
    expect(checked('status')).toBe(true)
    expect(checked('id')).toBe(false)
  })

  it('rejects an empty selection before calling the API', async () => {
    const user = userEvent.setup()
    render(renderDialog(['id']))
    await waitFor(() => expect(checked('id')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'id' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(screen.getByText('Select at least one column')).toBeInTheDocument()
    expect(setPrimaryKey).not.toHaveBeenCalled()
  })

  it('saves the selected columns and closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(renderDialog(['id'], onClose))
    await waitFor(() => expect(checked('id')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'email' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(setPrimaryKey).toHaveBeenCalledWith(
      'session-1',
      'app_db',
      'users',
      ['id', 'email'],
    )
  })

  it.each([
    [new Error('write failed'), 'Error: write failed'],
    ['write failed', 'write failed'],
  ])('surfaces a failed save', async (failure, expected) => {
    setPrimaryKey.mockRejectedValueOnce(failure)
    const user = userEvent.setup()
    render(renderDialog(['id']))
    await waitFor(() => expect(checked('id')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('drops the current key only after confirmation and reports failure', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(renderDialog(['id'], onClose))
    await waitFor(() => expect(checked('id')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Drop PK' }))
    await waitFor(() => expect(dropPrimaryKey).toHaveBeenCalledWith('session-1', 'app_db', 'users'))
    expect(onClose).toHaveBeenCalledOnce()

    dropPrimaryKey.mockRejectedValueOnce('drop denied')
    render(renderDialog(['email']))
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Drop PK' })).toHaveLength(2))
    const dropButtons = screen.getAllByRole('button', { name: 'Drop PK' })
    await user.click(dropButtons[1])
    expect(await screen.findByText('drop denied')).toBeInTheDocument()
  })
})
