import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
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

vi.mock('../../utils/clipboard', () => ({
  clipboardWrite: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../utils/toast', () => ({
  showToast: vi.fn(),
}))

const fetchMock = vi.mocked(apiFetch)
const writeMock = vi.mocked(clipboardWrite)

const props = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'lagun_test',
  table: 'users',
}

const rowsOverride = {
  columns: ['id', 'name'],
  rows: [[1, 'Alice'], [2, null]],
  autoIncrementColumns: ['id'],
}

let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let anchorClick: ReturnType<typeof vi.spyOn>

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

function lastBody() {
  return JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))
}

describe('ExportDialog form behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeMock.mockResolvedValue(undefined)
    createObjectURL = vi.fn(() => 'blob:download')
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('switches SQL formats, modes, schema, and auto-increment controls', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} />)

    expect(screen.getByRole('dialog', { name: 'Export lagun_test.users' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'INSERT Mode' })).toHaveTextContent('Single')
    expect(screen.getByRole('checkbox', { name: 'Include schema name' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Include auto-increment columns' })).toBeEnabled()

    await choose(user, 'INSERT Mode', 'Batch (bounded rows per INSERT)')
    await user.click(screen.getByRole('checkbox', { name: 'Include schema name' }))
    await user.click(screen.getByRole('checkbox', { name: 'Include auto-increment columns' }))
    await choose(user, 'Format', 'DELETE SQL')

    expect(screen.queryByRole('button', { name: 'INSERT Mode' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Include schema name' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Include auto-increment columns' })).toBeDisabled()
    expect(screen.getByText(/Downloads all rows from/)).toBeInTheDocument()

    await choose(user, 'Format', 'DELETE + INSERT SQL')
    expect(screen.getByRole('button', { name: 'INSERT Mode' })).toHaveTextContent('Batch')
  })

  it('starts custom SQL exports as CSV without SQL-only choices', () => {
    render(<ExportDialog {...props} sql="SELECT * FROM users" />)

    expect(screen.getByRole('button', { name: 'Format' })).toHaveTextContent('CSV')
    expect(screen.queryByRole('option', { name: 'INSERT SQL' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'DELETE SQL' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Include auto-increment columns' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'INSERT Mode' })).not.toBeInTheDocument()
  })

  it('shows filtered-row, selected-row, and JSON guidance', async () => {
    const user = userEvent.setup()
    const view = render(
      <ExportDialog {...props} rowsOverride={rowsOverride} rowsOverrideLabel="selected rows" />,
    )

    expect(screen.getByText(/2 selected rows/)).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Include auto-increment columns' })).toBeEnabled()
    await choose(user, 'Format', 'JSON')
    expect(screen.queryByRole('button', { name: 'Batch Size' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Include schema name' })).not.toBeInTheDocument()
    expect(screen.getByText(/JSON exports all selected columns/)).toBeInTheDocument()

    view.rerender(<ExportDialog {...props} pkValues={[{ id: 1 }, { id: 2 }]} />)
    expect(screen.getByText(/2 selected rows/)).toBeInTheDocument()
  })

  it('reveals and applies every advanced CSV option', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))

    await choose(user, 'Delimiter', 'Custom')
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), ';ignored')
    await choose(user, 'Quote Character', 'None')
    await choose(user, 'Escape Character', 'Backslash (\\)')
    await choose(user, 'Line Ending', 'LF (Unix/Mac)')
    await choose(user, 'Encoding', 'UTF-8 with BOM')

    expect(screen.getByRole('textbox', { name: 'Custom' })).toHaveValue(';')
    expect(screen.getByText(/CSV cells starting with/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    expect(screen.queryByRole('button', { name: 'Delimiter' })).not.toBeInTheDocument()
  })

  it('resets the form when reopened', async () => {
    const user = userEvent.setup()
    const view = render(<ExportDialog {...props} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    await choose(user, 'Line Ending', 'CR (Legacy Mac)')
    await user.clear(screen.getByRole('spinbutton', { name: 'Batch Size' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Batch Size' }), '5')

    view.rerender(<ExportDialog {...props} open={false} />)
    view.rerender(<ExportDialog {...props} />)

    expect(screen.getByRole('button', { name: 'Format' })).toHaveTextContent('INSERT SQL')
    expect(screen.getByRole('spinbutton', { name: 'Batch Size' })).toHaveValue(500)
    expect(screen.queryByRole('button', { name: 'Delimiter' })).not.toBeInTheDocument()
  })
})

describe('ExportDialog frontend downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createObjectURL = vi.fn(() => 'blob:download')
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads JSON rows with the expected file and content type', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} onClose={onClose} />)
    await choose(user, 'Format', 'JSON')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(anchorClick).toHaveBeenCalledOnce()
    expect(showToast).toHaveBeenCalledWith('Downloaded lagun_test_users_filtered.json.')
    expect(fetchMock).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:download')
  })

  it('downloads CSV with custom options', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} onClose={onClose} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    await choose(user, 'Delimiter', 'Semicolon (;)')
    await choose(user, 'Line Ending', 'LF (Unix/Mac)')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('text/plain;charset=utf-8')
    expect(showToast).toHaveBeenCalledWith('Downloaded lagun_test_users_filtered.csv.')
  })

  it('downloads SQL generated from loaded rows', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(showToast).toHaveBeenCalledWith('Downloaded lagun_test_users_filtered.sql.')
  })

  it('abandons a row download when the dialog closes before the paint yield', async () => {
    let frame!: FrameRequestCallback
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frame = callback
      return 1
    })
    const user = userEvent.setup()
    const onClose = vi.fn()
    const view = render(
      <ExportDialog {...props} rowsOverride={rowsOverride} onClose={onClose} />,
    )
    await user.click(screen.getByRole('button', { name: 'Download' }))
    view.rerender(<ExportDialog {...props} rowsOverride={rowsOverride} onClose={onClose} open={false} />)
    act(() => frame(0))

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('abandons a row download when it is cancelled during content generation', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    let cancelled = false
    const cancellableRows = {
      rows: [[1]],
      autoIncrementColumns: ['id'],
      get columns(): string[] {
        if (!cancelled) {
          cancelled = true
          screen.getByRole('button', { name: 'Cancel' }).click()
        }
        return ['id']
      },
    }
    render(
      <ExportDialog {...props} rowsOverride={cancellableRows} onClose={onClose} />,
    )
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('rejects incompatible CSV delimiter and quote characters', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    await choose(user, 'Delimiter', 'Custom')
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), '"')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CSV delimiter, quote, and escape characters must be compatible',
    )
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('rejects a CSV delimiter equal to the escape character', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    await choose(user, 'Delimiter', 'Custom')
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), '\\')
    await choose(user, 'Escape Character', 'Backslash (\\)')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'CSV delimiter, quote, and escape characters must be compatible',
    )
  })
})

describe('ExportDialog backend requests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeMock.mockResolvedValue(undefined)
    createObjectURL = vi.fn(() => 'blob:download')
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('posts the SQL body and downloads the server file', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    fetchMock.mockResolvedValue(new Response(
      'INSERT INTO `users` VALUES (1);\n-- Lagun export complete: 1 rows\n',
      {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="users_export.sql"' },
      },
    ))
    render(<ExportDialog {...props} onClose={onClose} pkValues={[{ id: 1 }]} />)
    await choose(user, 'Format', 'DELETE + INSERT SQL')
    await user.click(screen.getByRole('checkbox', { name: 'Include schema name' }))
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(lastBody()).toEqual({
      database: 'lagun_test',
      table: 'users',
      format: 'delete+insert',
      exclude_auto_increment: true,
      batch_size: 500,
      insert_mode: 'single',
      include_schema: true,
      pk_values: [{ id: 1 }],
    })
    expect(showToast).toHaveBeenCalledWith('Downloaded users_export.sql.')
  })

  it('uses the custom SQL and CSV payload contract', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response('name\nAlice\n', { status: 200 }))
    render(<ExportDialog {...props} sql="SELECT * FROM users" />)
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    await choose(user, 'Delimiter', 'Pipe (|)')
    await choose(user, 'Quote Character', 'None')
    await choose(user, 'Escape Character', 'None')
    await choose(user, 'Encoding', 'ASCII')
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(showToast).toHaveBeenCalled())
    expect(lastBody()).toEqual({
      database: 'lagun_test',
      sql: 'SELECT * FROM users',
      format: 'csv',
      exclude_auto_increment: true,
      batch_size: 500,
      csv_delimiter: '|',
      csv_quotechar: '',
      csv_escapechar: '',
      csv_lineterminator: '\r\n',
      csv_encoding: 'ascii',
    })
  })

  it('surfaces an HTTP failure and changes Download to Retry', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'export denied' }), {
      status: 403,
      statusText: 'Forbidden',
    }))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: export denied')
    expect(screen.getByRole('button', { name: 'Retry Download' })).toBeInTheDocument()
    expect(showToast).toHaveBeenCalledWith('Export failed: export denied', 'error')
  })

  it('rejects a truncated SQL download', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response('INSERT INTO users;\n', { status: 200 }))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Export failed: the download ended before the export finished',
    )
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('surfaces a mid-stream export failure message', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(
      'INSERT INTO users;\n-- Lagun export FAILED: server stopped\n',
      { status: 200 },
    ))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Export failed: server stopped',
    )
  })

  it.each([
    ['non-integer', '1.5'],
    ['below one', '0'],
    ['above ten thousand', '10001'],
  ])('rejects a batch size that is %s', async (_label, value) => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} />)
    const batchSize = screen.getByRole('spinbutton', { name: 'Batch Size' })
    await user.clear(batchSize)
    await user.type(batchSize, value)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('1 to 10,000')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a JSON backend request reached after rows disappear', async () => {
    const user = userEvent.setup()
    const view = render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await choose(user, 'Format', 'JSON')
    view.rerender(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'JSON export is only available for rows currently loaded in the grid',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a non-Error transport failure', async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValue('network down')
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: network down')
  })

  it('closes during an export, aborts it, and ignores the late rejection', async () => {
    const user = userEvent.setup()
    const gate = deferred<Response>()
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_input, init) => {
      signal = init?.signal ?? undefined
      return gate.promise
    })
    const onClose = vi.fn()
    render(<ExportDialog {...props} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.reject(new Error('late failure')))

    expect(onClose).toHaveBeenCalledOnce()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('aborts an export when the open prop changes and ignores an AbortError', async () => {
    const user = userEvent.setup()
    const gate = deferred<Response>()
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_input, init) => {
      signal = init?.signal ?? undefined
      return gate.promise
    })
    const view = render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    view.rerender(<ExportDialog {...props} open={false} />)
    await act(async () => gate.reject(new DOMException('Aborted', 'AbortError')))

    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText(/Export failed/)).not.toBeInTheDocument()
  })

  it('closes an export without a body and reports a fallback filename', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    const noBody = {
      ok: true,
      headers: new Headers(),
      body: null,
      text: async () => 'INSERT INTO users;\n-- Lagun export complete: 1 rows\n',
    } as unknown as Response
    fetchMock.mockResolvedValue(noBody)
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Downloaded lagun_test_users.sql.'))
  })

  it('ignores download progress and completion after the dialog closes', async () => {
    const user = userEvent.setup()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }))
    const view = render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))
    view.rerender(<ExportDialog {...props} open={false} />)

    act(() => {
      streamController.enqueue(new TextEncoder().encode('INSERT INTO users;\n-- Lagun export complete: 1 rows\n'))
      streamController.close()
    })
    await waitFor(() => expect(createObjectURL).not.toHaveBeenCalled())
    expect(showToast).not.toHaveBeenCalled()
  })

  it('does not close again when cancellation lands during download completion', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    createObjectURL.mockImplementationOnce(() => {
      screen.getByRole('button', { name: 'Cancel' }).click()
      return 'blob:download'
    })
    fetchMock.mockResolvedValue(new Response(
      'INSERT INTO users;\n-- Lagun export complete: 1 rows\n',
      { status: 200 },
    ))
    render(<ExportDialog {...props} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce())
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('ExportDialog copy behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    writeMock.mockResolvedValue(undefined)
    createObjectURL = vi.fn(() => 'blob:download')
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('copies frontend JSON rows', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await choose(user, 'Format', 'JSON')
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(writeMock).toHaveBeenCalledOnce())
    expect(JSON.parse(writeMock.mock.calls[0][0])).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: null },
    ])
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })

  it('keeps prepared text after a blocked write and copies it on retry', async () => {
    const user = userEvent.setup()
    writeMock.mockRejectedValueOnce(new Error('clipboard blocked')).mockResolvedValueOnce(undefined)
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/Copy again/)
    expect(showToast).toHaveBeenCalledWith(
      'The export is ready. Click Copy again to finish copying.',
    )
    await user.click(screen.getByRole('button', { name: 'Copy again' }))
    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })

  it('clears a prepared copy when the export setup changes', async () => {
    const user = userEvent.setup()
    writeMock.mockRejectedValueOnce(new Error('clipboard blocked')).mockResolvedValueOnce(undefined)
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copy again' })).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Include auto-increment columns' }))
    expect(screen.queryByRole('button', { name: 'Copy again' })).not.toBeInTheDocument()
  })

  it('rejects a frontend copy above 16 MB', async () => {
    const user = userEvent.setup()
    render(
      <ExportDialog
        {...props}
        rowsOverride={{ columns: ['payload'], rows: [['x'.repeat(16 * 1024 * 1024 + 1)]] }}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copy failed: Copy is limited to 16 MB. Use Download for large exports.',
    )
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('copies backend SQL text and validates its completion marker', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    fetchMock.mockResolvedValue(new Response(
      'INSERT INTO users;\n-- Lagun export complete: 1 rows\n',
      { status: 200 },
    ))
    render(<ExportDialog {...props} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(writeMock).toHaveBeenCalledOnce())
    expect(writeMock.mock.calls[0][0]).toContain('Lagun export complete')
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('copies backend CSV text without requiring a SQL completion marker', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response('name\r\nAlice\r\n', { status: 200 }))
    render(<ExportDialog {...props} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(writeMock).toHaveBeenCalledWith('name\r\nAlice\r\n'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })

  it('reports a failed copy request and a truncated copy', async () => {
    const user = userEvent.setup()
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'copy denied' }), {
        status: 403,
        statusText: 'Forbidden',
      }))
      .mockResolvedValueOnce(new Response('INSERT INTO users;\n', { status: 200 }))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed: copy denied')

    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Copy failed: the download ended before the export finished',
    ))
  })

  it('uses the fallback message for an empty export failure marker', async () => {
    const user = userEvent.setup()
    fetchMock.mockResolvedValue(new Response(
      'INSERT INTO users;\n-- Lagun export FAILED: \n',
      { status: 200 },
    ))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copy failed: the export failed before it finished',
    )
  })

  it('rejects CSV options before a frontend copy', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await choose(user, 'Format', 'CSV')
    await user.click(screen.getByRole('button', { name: 'Advanced CSV Options' }))
    await choose(user, 'Delimiter', 'Custom')
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), '"')
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copy failed: CSV delimiter, quote, and escape characters must be compatible',
    )
  })

  it('reports a non-Error row-building failure', async () => {
    const user = userEvent.setup()
    const brokenRows = {
      rows: [[1]],
      get columns(): string[] {
        throw 'row source failed'
      },
    } as unknown as typeof rowsOverride
    render(<ExportDialog {...props} rowsOverride={brokenRows} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copy failed: row source failed',
    )
  })

  it('rejects a JSON backend copy reached after rows disappear', async () => {
    const user = userEvent.setup()
    const view = render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await choose(user, 'Format', 'JSON')
    view.rerender(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copy failed: JSON export is only available for rows currently loaded in the grid',
    )
  })

  it('shows copy progress while the backend request is pending', async () => {
    const user = userEvent.setup()
    const gate = deferred<Response>()
    fetchMock.mockImplementationOnce(() => gate.promise)
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(screen.getByRole('progressbar', { name: 'Copy progress' })).toBeInTheDocument()
    expect(screen.getByText('Generating export text…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copying…' })).toBeDisabled()
    await act(async () => gate.resolve(new Response(
      'INSERT INTO users;\n-- Lagun export complete: 1 rows\n',
      { status: 200 },
    )))
    await waitFor(() => expect(writeMock).toHaveBeenCalledOnce())
  })

  it('aborts a pending copy on cancel and ignores its late rejection', async () => {
    const user = userEvent.setup()
    const gate = deferred<Response>()
    let signal: AbortSignal | undefined
    fetchMock.mockImplementationOnce((_input, init) => {
      signal = init?.signal ?? undefined
      return gate.promise
    })
    const onClose = vi.fn()
    render(<ExportDialog {...props} onClose={onClose} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal?.aborted).toBe(true)
    await act(async () => gate.reject('late copy failure'))

    expect(onClose).toHaveBeenCalledOnce()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('aborts a pending copy on close and reports a non-Error failure', async () => {
    const user = userEvent.setup()
    const gate = deferred<Response>()
    fetchMock.mockImplementationOnce(() => gate.promise)
    const view = render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    view.rerender(<ExportDialog {...props} open={false} />)
    await act(async () => gate.reject('copy failed plainly'))

    expect(screen.queryByText(/copy failed plainly/)).not.toBeInTheDocument()

    fetchMock.mockRejectedValueOnce('copy failed plainly')
    view.rerender(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed: copy failed plainly')
  })

  it('silently ignores an AbortError from a still-current copy', async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('reports a DOMException that is not an abort', async () => {
    const user = userEvent.setup()
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed: TimeoutError: timed out')
  })

  it('abandons a frontend clipboard write after close', async () => {
    const user = userEvent.setup()
    const gate = deferred<void>()
    writeMock.mockImplementationOnce(() => gate.promise)
    const view = render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    view.rerender(<ExportDialog {...props} rowsOverride={rowsOverride} open={false} />)
    await act(async () => gate.resolve())

    expect(screen.queryByRole('button', { name: /Copied/ })).not.toBeInTheDocument()
  })

  it('abandons a frontend clipboard rejection after close', async () => {
    const user = userEvent.setup()
    const gate = deferred<void>()
    writeMock.mockImplementationOnce(() => gate.promise)
    const view = render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    view.rerender(<ExportDialog {...props} rowsOverride={rowsOverride} open={false} />)
    await act(async () => gate.reject(new Error('late clipboard failure')))

    expect(screen.queryByText(/Click Copy again/)).not.toBeInTheDocument()
  })

  it('shows download bytes as progress arrives', async () => {
    const user = userEvent.setup()
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
    })
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }))
    render(<ExportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Download' }))

    act(() => streamController.enqueue(new Uint8Array(2048)))
    expect(await screen.findByText(/2.0 KB received/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Download progress' })).toBeInTheDocument()
    act(() => {
      streamController.enqueue(new TextEncoder().encode('\n-- Lagun export complete: 1 rows\n'))
      streamController.close()
    })
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce())
  })

  it('resets the Copied label after the confirmation timeout', async () => {
    const user = userEvent.setup()
    render(<ExportDialog {...props} rowsOverride={rowsOverride} />)
    await user.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument(),
      { timeout: 2_500 },
    )
  })
})
