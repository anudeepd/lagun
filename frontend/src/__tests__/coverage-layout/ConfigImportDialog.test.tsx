import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfigImportDialog from '../../components/sessions/ConfigImportDialog'
import { api } from '../../api/client'
import { useSessionStore } from '../../store/sessionStore'

function file(name = 'lagun-export.json', contents = '{"connections":[]}') {
  return new File([contents], name, { type: 'application/json' })
}

describe('ConfigImportDialog', () => {
  const loadSessions = vi.fn()

  beforeEach(() => {
    loadSessions.mockReset()
    loadSessions.mockResolvedValue(undefined)
    useSessionStore.setState({ loadSessions })
    vi.spyOn(api, 'importConfig').mockResolvedValue({ imported: 1, skipped: 0 })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('asks for a file when Enter is pressed before selecting one', async () => {
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    await user.type(screen.getByLabelText('Passphrase'), 'secret{Enter}')

    expect(screen.getByRole('alert')).toHaveTextContent('Select a file first.')
    expect(api.importConfig).not.toHaveBeenCalled()
  })

  it('requires the export passphrase', async () => {
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    await user.upload(screen.getByLabelText('Export file'), file())
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the passphrase used during export.',
    )
    expect(api.importConfig).not.toHaveBeenCalled()
  })

  it('imports a file, reloads connections, and resets on Done', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={onClose} />)

    await user.upload(screen.getByLabelText('Export file'), file())
    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await screen.findByText('Import complete')
    expect(screen.getByText('1 connection imported.')).toBeInTheDocument()
    expect(screen.queryByText(/skipped/)).not.toBeInTheDocument()
    expect(loadSessions).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('reports plural imports and skipped entries', async () => {
    vi.mocked(api.importConfig).mockResolvedValueOnce({ imported: 2, skipped: 3 })
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    await user.upload(screen.getByLabelText('Export file'), file())
    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText('2 connections imported, 3 skipped.')).toBeInTheDocument()
    expect(
      screen.getByText(/Skipped entries duplicate a connection/),
    ).toBeInTheDocument()
  })

  it('rejects files larger than 5 MB and clears the input', async () => {
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    const input = screen.getByLabelText('Export file') as HTMLInputElement
    await user.upload(input, new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.json'))

    expect(screen.getByRole('alert')).toHaveTextContent('Export file exceeds 5 MB limit.')
    expect(input.value).toBe('')
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('clears a previous error when a valid file is selected', async () => {
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    await user.upload(screen.getByLabelText('Export file'), file())
    await user.clear(screen.getByLabelText('Passphrase'))
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter the passphrase used during export.',
    )

    await user.upload(screen.getByLabelText('Export file'), file('second.json'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('handles a cleared file picker and resets from Cancel', async () => {
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={onClose} />)

    const input = screen.getByLabelText('Export file')
    fireEvent.change(input, { target: { files: [] } })
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()

    await user.upload(input, file())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Export file')).toHaveValue('')
  })

  it('shows Error and stringified import failures', async () => {
    vi.mocked(api.importConfig).mockRejectedValueOnce(new Error('Wrong passphrase'))
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={() => {}} />)

    await user.upload(screen.getByLabelText('Export file'), file())
    await user.type(screen.getByLabelText('Passphrase'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong passphrase')

    vi.mocked(api.importConfig).mockRejectedValueOnce('network down')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
  })

  it('submits from Enter, ignores IME composition, and ignores a second import while busy', async () => {
    let release: (value: { imported: number; skipped: number }) => void = () => {}
    vi.mocked(api.importConfig).mockImplementation(
      () => new Promise(resolve => { release = resolve }),
    )
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ConfigImportDialog open onClose={onClose} />)

    await user.upload(screen.getByLabelText('Export file'), file())
    const passphrase = screen.getByLabelText('Passphrase')
    await user.type(passphrase, 'secret')
    fireEvent.keyDown(passphrase, { key: 'Enter', code: 'Enter', isComposing: true })
    expect(api.importConfig).not.toHaveBeenCalled()

    fireEvent.keyDown(passphrase, { key: 'x' })
    expect(api.importConfig).not.toHaveBeenCalled()

    fireEvent.keyDown(passphrase, { key: 'Enter' })
    await waitFor(() => expect(api.importConfig).toHaveBeenCalledOnce())
    expect(screen.getByRole('status')).toHaveTextContent('Importing connections…')

    const importButton = screen.getByRole('button', { name: 'Import' })
    expect(importButton).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Close dialog'))
    expect(onClose).not.toHaveBeenCalled()

    release({ imported: 1, skipped: 0 })
    await screen.findByText('Import complete')
  })
})
