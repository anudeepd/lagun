import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExportDialog from '../../components/table/ExportDialog'
import { apiFetch } from '../../api/client'
import type * as ClientModule from '../../api/client'
import { clipboardWrite } from '../../utils/clipboard'
import { showToast } from '../../utils/toast'

vi.mock('../../api/client', async importOriginal => {
  const actual = await importOriginal<typeof ClientModule>()
  return { ...actual, apiFetch: vi.fn() }
})

vi.mock('../../utils/clipboard', () => ({ clipboardWrite: vi.fn() }))
vi.mock('../../utils/toast', () => ({ showToast: vi.fn() }))

const fetchMock = vi.mocked(apiFetch)
const writeMock = vi.mocked(clipboardWrite)

const props = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'lagun_test',
  table: 'users',
}

async function copyWith(body: string) {
  fetchMock.mockResolvedValue(new Response(body, { status: 200 }))
  render(<ExportDialog {...props} />)
  await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
}

describe('ExportDialog copy stream guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a SQL body that ends before the completion marker', async () => {
    await copyWith(
      '-- Lagun export: users\nINSERT INTO `users` (`id`) VALUES (1);\n'
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'the download ended before the export finished'
      )
    )
    expect(writeMock).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(
      'Copy failed: the download ended before the export finished',
      'error'
    )
  })

  it('surfaces the message from a mid-stream FAILED marker', async () => {
    await copyWith(
      '-- Lagun export: users\nINSERT INTO `users` (`id`) VALUES (1);\n' +
        '-- Lagun export FAILED: Export exceeded the 300-second limit after 1 rows\n'
    )

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Export exceeded the 300-second limit after 1 rows'
      )
    )
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('accepts a SQL body that carries the completion marker', async () => {
    await copyWith(
      '-- Lagun export: users\nINSERT INTO `users` (`id`) VALUES (1);\n' +
        '-- Lagun export complete: 1 rows\n'
    )

    await waitFor(() => expect(writeMock).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })
  it('offers JSON alongside CSV for loaded rows and copies them as row objects', async () => {
    render(<ExportDialog
      {...props}
      rowsOverride={{
        columns: ['id', 'name'],
        rows: [[1, 'Alice'], [2, null]],
        autoIncrementColumns: ['id'],
      }}
      rowsOverrideLabel="selected rows"
    />)

    await userEvent.click(screen.getByRole('button', { name: 'Format' }))
    expect(screen.getByRole('option', { name: 'CSV' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('option', { name: 'JSON' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(writeMock).toHaveBeenCalledOnce())
    expect(JSON.parse(writeMock.mock.calls[0][0])).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: null },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the prepared text and finishes copying on the next click when the browser blocks the first write', async () => {
    writeMock
      .mockRejectedValueOnce(new Error('The Clipboard API is unavailable on this connection'))
      .mockResolvedValueOnce(undefined)

    render(<ExportDialog
      {...props}
      rowsOverride={{
        columns: ['id', 'name'],
        rows: [[1, 'Alice']],
        autoIncrementColumns: ['id'],
      }}
    />)

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/click Copy again/i)
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Copy again' }))
    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })

  it('shows download progress until the complete file is ready, then closes', async () => {
    const createObjectURL = vi.fn(() => 'blob:export')
    const revokeObjectURL = vi.fn()
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller },
    })
    fetchMock.mockResolvedValue(new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="lagun_test_users_insert.sql"',
      },
    }))

    try {
      render(<ExportDialog {...props} />)
      await userEvent.click(screen.getByRole('button', { name: 'Download' }))

      expect(await screen.findByRole('progressbar', { name: 'Download progress' })).toBeInTheDocument()
      streamController.enqueue(
        new TextEncoder().encode(
          '-- Lagun export: users\nINSERT INTO `users` (`id`) VALUES (1);\n' +
          '-- Lagun export complete: 1 rows\n'
        )
      )
      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(/received/)
      )

      streamController.close()
      await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce())
      expect(createObjectURL).toHaveBeenCalledOnce()
      expect(showToast).toHaveBeenCalledWith('Downloaded lagun_test_users_insert.sql.')
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke })
      clickSpy.mockRestore()
    }
  })

  it('rejects a batch size above the server limit instead of silently substituting 500', async () => {
    render(<ExportDialog {...props} />)
    const batchSize = screen.getByLabelText('Batch Size')
    await userEvent.clear(batchSize)
    await userEvent.type(batchSize, '10001')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('1 to 10,000')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
