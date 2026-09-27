import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditColumnDialog from '../../components/table/EditColumnDialog'
import { api } from '../../api/client'
import { showToast } from '../../utils/toast'

vi.mock('../../api/client', () => ({
  api: {
    addColumn: vi.fn(),
    modifyColumn: vi.fn(),
  },
}))

vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }))

const addColumn = vi.mocked(api.addColumn)

const baseProps = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'lagun_test',
  table: 'users',
  mode: 'add' as const,
}

describe('EditColumnDialog save flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addColumn.mockResolvedValue({ ok: true, sql: 'ALTER TABLE `users` ADD COLUMN `created_at` VARCHAR(255)' })
  })

  it('waits for schema refresh before closing and confirms addition', async () => {
    let resolveRefresh: () => void = () => {}
    const refresh = new Promise<void>(resolve => { resolveRefresh = resolve })
    const onSaved = vi.fn(() => refresh)
    const onClose = vi.fn()

    render(<EditColumnDialog {...baseProps} onSaved={onSaved} onClose={onClose} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'created_at')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(addColumn).toHaveBeenCalledWith('session-1', 'lagun_test', 'users', {
      name: 'created_at',
      type: 'VARCHAR(255)',
      nullable: true,
      default: null,
      comment: undefined,
    })
    expect(onClose).not.toHaveBeenCalled()

    resolveRefresh()
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(showToast).toHaveBeenCalledWith('Column created_at added.', 'success')
  })

  it('sends selected function default without quoting it as a literal', async () => {
    const onSaved = vi.fn()
    render(<EditColumnDialog {...baseProps} onSaved={onSaved} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'external_id')
    await userEvent.click(screen.getByRole('button', { name: 'Default' }))
    await userEvent.click(screen.getByRole('option', { name: 'UUID()' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(addColumn).toHaveBeenCalledWith('session-1', 'lagun_test', 'users', {
      name: 'external_id',
      type: 'VARCHAR(255)',
      nullable: true,
      default: 'UUID()',
      comment: undefined,
    })
  })

  it('restores expression defaults while editing a column', () => {
    render(
      <EditColumnDialog
        {...baseProps}
        mode="modify"

        column={{
          name: 'created_at',
          data_type: 'timestamp',
          column_type: 'timestamp',
          is_nullable: false,
          column_default: 'CURRENT_TIMESTAMP(6)',
          is_primary_key: false,
          is_auto_increment: false,
          extra: '',
          comment: '',
        }}
        onSaved={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Default' })).toHaveTextContent('CURRENT_TIMESTAMP(6)')
    expect(screen.queryByRole('textbox', { name: 'Literal Value' })).not.toBeInTheDocument()
  })

  it('restores MySQL date aliases as expression defaults', () => {
    render(
      <EditColumnDialog
        {...baseProps}
        mode="modify"
        column={{
          name: 'created_on',
          data_type: 'date',
          column_type: 'date',
          is_nullable: true,
          column_default: 'curdate()',
          is_primary_key: false,
          is_auto_increment: false,
          extra: 'DEFAULT_GENERATED',
          comment: '',
        }}
        onSaved={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Default' })).toHaveTextContent('CURRENT_DATE')
  })
  it('rejects incompatible expression defaults before API call', async () => {
    render(<EditColumnDialog {...baseProps} onSaved={vi.fn()} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'created_on')
    await userEvent.click(screen.getByRole('button', { name: 'Default' }))
    await userEvent.click(screen.getByRole('option', { name: 'CURRENT_DATE' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('CURRENT_DATE default requires DATE.')).toBeInTheDocument()
    expect(addColumn).not.toHaveBeenCalled()
  })
  it('marks literal defaults so reserved expressions stay quoted', async () => {
    const onSaved = vi.fn()
    render(<EditColumnDialog {...baseProps} onSaved={onSaved} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'status')
    await userEvent.click(screen.getByRole('button', { name: 'Default' }))
    await userEvent.click(screen.getByRole('option', { name: 'Literal' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Literal Value' }), 'CURRENT_TIMESTAMP')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(addColumn).toHaveBeenCalledWith('session-1', 'lagun_test', 'users', {
      name: 'status',
      type: 'VARCHAR(255)',
      nullable: true,
      default: 'CURRENT_TIMESTAMP',
      default_is_literal: true,
      comment: undefined,
    })
  })

  it('disables Save while the request is in flight, so a second click cannot submit twice', async () => {
    // Promise.withResolvers is ES2024; this project's tsconfig lib is ES2020, so
    // the executor form is the only one that type-checks.
    let resolveAdd: (value: { ok: boolean; sql: string }) => void = () => {}
    addColumn.mockImplementationOnce(() => new Promise(resolve => { resolveAdd = resolve }))
    const onSaved = vi.fn().mockResolvedValue(undefined)

    render(<EditColumnDialog {...baseProps} onSaved={onSaved} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'created_at')

    const save = screen.getByRole('button', { name: 'Add' })
    expect(save).toBeEnabled()
    await userEvent.click(save)

    // In flight: the button is disabled for the whole round trip, so the
    // second click below cannot fire a second ALTER.
    await waitFor(() => expect(save).toBeDisabled())
    await userEvent.click(save)
    expect(addColumn).toHaveBeenCalledTimes(1)

    resolveAdd({ ok: true, sql: 'ALTER TABLE `users` ADD COLUMN `created_at` VARCHAR(255)' })
    await waitFor(() => expect(save).toBeEnabled())
  })

  it('reopens usable after a close abandoned a save in flight', async () => {
    let resolveAdd: (value: { ok: boolean; sql: string }) => void = () => {}
    addColumn.mockImplementationOnce(() => new Promise(resolve => { resolveAdd = resolve }))
    const onSaved = vi.fn().mockResolvedValue(undefined)

    const view = render(<EditColumnDialog {...baseProps} onSaved={onSaved} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'created_at')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled())

    // Close while the ALTER is still in flight, then reopen the same mounted
    // instance — the schema view keeps this dialog mounted for its exit
    // animation, so component state survives.
    view.rerender(<EditColumnDialog {...baseProps} open={false} onSaved={onSaved} />)
    view.rerender(<EditColumnDialog {...baseProps} onSaved={onSaved} />)

    // The abandoned request's `finally` is fenced by the request id, so it never
    // clears `saving`: the reset on open is the only thing that can, and without
    // it Save stays disabled for the rest of the session.
    const save = screen.getByRole('button', { name: 'Add' })
    await waitFor(() => expect(save).toBeEnabled())

    // The late completion must not close the reopened dialog either.
    resolveAdd({ ok: true, sql: 'ALTER TABLE `users` ADD COLUMN `created_at` VARCHAR(255)' })
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(baseProps.onClose).not.toHaveBeenCalled()
    expect(save).toBeEnabled()
  })
})
