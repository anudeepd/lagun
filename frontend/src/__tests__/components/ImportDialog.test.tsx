import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportDialog from '../../components/table/ImportDialog'

const props = {
  open: true,
  onClose: () => {},
  sessionId: 'session-1',
  database: 'lagun_test',
}

describe('ImportDialog formats', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows non-blocking feedback when a drop event is delayed', () => {
    vi.useFakeTimers()
    render(<ImportDialog {...props} />)

    const dropZone = screen.getByRole('button', { name: 'Choose import file' })
    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()

    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing upload…')

    act(() => vi.advanceTimersByTime(15_000))
    expect(screen.getByRole('status')).toHaveTextContent("Upload hasn't started yet.")
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers CSV and MySQL dump formats', () => {
    render(<ImportDialog {...props} />)
    expect(screen.getByLabelText('File Format')).toBeInTheDocument()
    expect(screen.getByText('CSV Format Options')).toBeInTheDocument()
  })

  it('reveals the advanced CSV options on demand', async () => {
    render(<ImportDialog {...props} />)

    expect(screen.queryByLabelText('Delimiter')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'CSV Format Options' }))
    expect(await screen.findByLabelText('Delimiter')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'CSV Format Options' }))
    await waitFor(() => expect(screen.queryByLabelText('Delimiter')).not.toBeInTheDocument())
  })

  it('layers the target-table menu above the import dialog', async () => {
    render(<ImportDialog {...props} />)
    await userEvent.click(screen.getByLabelText('Target Table'))
    expect(screen.getByRole('listbox', { name: 'Target Table' })).toHaveClass('z-critical')
  })

  it('allows dump imports without a target table and warns about SQL execution', async () => {
    render(<ImportDialog {...props} />)
    await userEvent.click(screen.getByLabelText('File Format'))
    await userEvent.click(screen.getByRole('option', { name: 'MySQL dump (.sql / .dump)' }))
    expect(screen.queryByLabelText('Target Table')).not.toBeInTheDocument()
    expect(screen.queryByText(/execute SQL from the file/i)).toBeInTheDocument()
  })

  it('shows unrestricted dump scope despite a preselected table', async () => {
    render(<ImportDialog {...props} table="users" />)
    await userEvent.click(screen.getByLabelText('File Format'))
    await userEvent.click(screen.getByRole('option', { name: 'MySQL dump (.sql / .dump)' }))
    expect(screen.getByText('Import MySQL dump into lagun_test')).toBeInTheDocument()
    expect(screen.queryByText('Import into lagun_test.users')).not.toBeInTheDocument()
  })

  it('uses a bounded file slice only when preview is requested', async () => {
    let uploadedBytes = 0
    render(<ImportDialog {...props} table="users" />)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const form = init?.body as FormData
      uploadedBytes = (form.get('file') as File).size
      return new Response(JSON.stringify({
        format: 'csv',
        columns: ['name'],
        rows: [['Alice']],
        total_lines_sampled: 1,
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File([new Uint8Array(2 * 1024 * 1024)], 'large.csv', { type: 'text/csv' })
    await userEvent.upload(input!, file)

    expect(screen.getByRole('button', { name: /selected file large.csv/i })).toBeInTheDocument()
    expect(uploadedBytes).toBe(0)
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Alice')
    expect(uploadedBytes).toBe(1024 * 1024)
    fetchSpy.mockRestore()
  })

  it('shows a determinate upload bar, then an indeterminate one while the server imports', async () => {
    const sent: FakeXhr[] = []
    class FakeXhr {
      upload = {
        onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null,
        onload: null as (() => void) | null,
      }
      status = 0
      statusText = ''
      responseText = ''
      onabort: (() => void) | null = null
      onerror: (() => void) | null = null
      onload: (() => void) | null = null
      open() {}
      send = () => { sent.push(this) }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)

    render(<ImportDialog {...props} table="users" />)
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    await userEvent.upload(input!, new File(['name\nAlice\n'], 'rows.csv', { type: 'text/csv' }))
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))

    // No byte count yet, so no number: indeterminate rather than a fake 0%.
    const pending = screen.getByRole('progressbar', { name: 'Importing' })
    expect(pending).not.toHaveAttribute('aria-valuenow')

    act(() => sent[0].upload.onprogress?.({ lengthComputable: true, loaded: 30, total: 120 }))
    expect(screen.getByRole('progressbar', { name: 'Uploading file' })).toHaveAttribute('aria-valuenow', '25')

    // Body sent: the server-side import reports nothing until it finishes.
    act(() => sent[0].upload.onload?.())
    expect(screen.getByRole('progressbar', { name: 'Importing' })).not.toHaveAttribute('aria-valuenow')

    await act(async () => {
      sent[0].status = 200
      sent[0].responseText = JSON.stringify({
        ok: true, rows_processed: 1, rows_imported: 1, method: 'csv',
      })
      sent[0].onload?.()
    })
    expect(screen.getByText(/Imported 1 rows/)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
