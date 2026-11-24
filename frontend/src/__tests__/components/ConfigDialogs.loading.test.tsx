import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfigExportDialog from '../../components/sessions/ConfigExportDialog'
import ConfigImportDialog from '../../components/sessions/ConfigImportDialog'
import { api } from '../../api/client'

// Both dialogs keep a plain "Download"/"Import" label on a disabled footer
// button while the request runs, so the announcement has to come from the
// dialog body; these tests pin exactly that.

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

describe('config dialogs loading announcements', () => {
  afterEach(() => vi.restoreAllMocks())

  it('announces an export in progress while the button keeps its label', async () => {
    vi.spyOn(api, 'exportConfig').mockImplementation(() => never())
    const user = userEvent.setup()
    render(<ConfigExportDialog open onClose={() => {}} />)

    await user.type(screen.getByLabelText('Passphrase'), 'hunter2')
    await user.type(screen.getByLabelText('Confirm passphrase'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Exporting connections…'),
    )
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled()
  })

  it('announces an import in progress outside the disabled fieldset', async () => {
    vi.spyOn(api, 'importConfig').mockImplementation(() => never())
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    await user.upload(
      screen.getByLabelText('Export file'),
      new File(['{"connections":[]}'], 'lagun-export.json', { type: 'application/json' }),
    )
    await user.type(screen.getByLabelText('Passphrase'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Importing connections…'),
    )
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    // A live region inside the inert fieldset would never be announced.
    expect(screen.getByRole('status').closest('fieldset')).toBeNull()
  })

  it('does not start an export or import while Enter confirms an IME composition', async () => {
    const exportConfig = vi.spyOn(api, 'exportConfig').mockImplementation(() => never())
    const importConfig = vi.spyOn(api, 'importConfig').mockImplementation(() => never())
    const user = userEvent.setup()

    const exportView = render(<ConfigExportDialog open onClose={() => {}} />)
    await user.type(screen.getByLabelText('Passphrase'), 'hunter2')
    const confirmPassphrase = screen.getByLabelText('Confirm passphrase')
    await user.type(confirmPassphrase, 'hunter2')

    fireEvent.keyDown(confirmPassphrase, {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
    })
    expect(exportConfig).not.toHaveBeenCalled()

    fireEvent.keyDown(confirmPassphrase, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(exportConfig).toHaveBeenCalledOnce())
    exportView.unmount()

    render(<ConfigImportDialog open onClose={() => {}} />)
    await user.upload(
      screen.getByLabelText('Export file'),
      new File(['{"connections":[]}'], 'lagun-export.json', { type: 'application/json' }),
    )
    const importPassphrase = screen.getByLabelText('Passphrase')
    await user.type(importPassphrase, 'hunter2')

    fireEvent.keyDown(importPassphrase, {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
    })
    expect(importConfig).not.toHaveBeenCalled()

    fireEvent.keyDown(importPassphrase, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(importConfig).toHaveBeenCalledOnce())
  })
})
