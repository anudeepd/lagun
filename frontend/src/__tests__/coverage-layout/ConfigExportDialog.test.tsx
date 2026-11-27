import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfigExportDialog from '../../components/sessions/ConfigExportDialog'
import { api } from '../../api/client'

function pending<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

describe('ConfigExportDialog', () => {
  beforeEach(() => {
    vi.spyOn(api, 'exportConfig').mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('requires a passphrase before exporting', async () => {
    const user = userEvent.setup()
    render(<ConfigExportDialog open onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a passphrase to protect the exported passwords.',
    )
    expect(api.exportConfig).not.toHaveBeenCalled()
  })

  it('rejects two different passphrases', async () => {
    const user = userEvent.setup()
    render(<ConfigExportDialog open onClose={() => {}} />)

    await user.type(screen.getByLabelText('Passphrase'), 'alpha')
    await user.type(screen.getByLabelText('Confirm passphrase'), 'beta')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Passphrases do not match.')
    expect(api.exportConfig).not.toHaveBeenCalled()
  })

  it('exports with matching passphrases, clears the form, and closes', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ConfigExportDialog open onClose={onClose} />)

    const passphrase = screen.getByLabelText('Passphrase')
    const confirm = screen.getByLabelText('Confirm passphrase')
    await user.type(passphrase, 'shared secret')
    await user.type(confirm, 'shared secret')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(api.exportConfig).toHaveBeenCalledWith('shared secret')
    expect(passphrase).toHaveValue('')
    expect(confirm).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('submits from the confirm field and ignores Enter during IME composition', async () => {
    const user = userEvent.setup()
    render(<ConfigExportDialog open onClose={() => {}} />)

    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    const confirm = screen.getByLabelText('Confirm passphrase')
    await user.type(confirm, 'secret')

    fireEvent.keyDown(confirm, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(api.exportConfig).not.toHaveBeenCalled()

    fireEvent.keyDown(confirm, { key: 'x' })
    expect(api.exportConfig).not.toHaveBeenCalled()

    fireEvent.keyDown(confirm, { key: 'Enter' })
    await waitFor(() => expect(api.exportConfig).toHaveBeenCalledWith('secret'))
  })

  it('shows Error messages and stringified failures', async () => {
    const user = userEvent.setup()
    const view = render(<ConfigExportDialog open onClose={() => {}} />)

    vi.mocked(api.exportConfig).mockRejectedValueOnce(new Error('Encryption unavailable'))
    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    await user.type(screen.getByLabelText('Confirm passphrase'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Encryption unavailable')

    vi.mocked(api.exportConfig).mockRejectedValueOnce('disk full')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    view.unmount()
  })

  it('announces progress, blocks dismissal, and ignores a second export while busy', async () => {
    const onClose = vi.fn()
    vi.mocked(api.exportConfig).mockImplementation(() => pending())
    const user = userEvent.setup()
    render(<ConfigExportDialog open onClose={onClose} />)

    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    await user.type(screen.getByLabelText('Confirm passphrase'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(screen.getByRole('status')).toHaveTextContent('Exporting connections…')
    const download = screen.getByRole('button', { name: 'Download' })
    expect(download).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Close dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('resets state from Cancel and closes from the modal backdrop', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    const view = render(<ConfigExportDialog open onClose={onClose} />)

    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Passphrase')).toHaveValue('')

    onClose.mockClear()
    const backdrop = view.baseElement.querySelector('.fixed.inset-0 > .absolute.inset-0')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
