import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportDialog from '../../components/table/ImportDialog'
import { api } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: {
    importPreview: vi.fn(),
    importFile: vi.fn(),
  },
}))

const { mockLoadTables, tablesByDatabase } = vi.hoisted(() => ({
  mockLoadTables: vi.fn(),
  tablesByDatabase: {
    'session-1/lagun_test': [{ name: 'users' }, { name: 'orders' }],
  } as Record<string, Array<{ name: string }>>,
}))

vi.mock('../../store/schemaStore', () => ({
  useSchemaStore: (selector: (state: {
    tables: Record<string, Array<{ name: string }>>
    loadTables: typeof mockLoadTables
  }) => unknown) => selector({ tables: tablesByDatabase, loadTables: mockLoadTables }),
}))

const importPreview = vi.mocked(api.importPreview)
const importFile = vi.mocked(api.importFile)

const props = {
  open: true,
  onClose: vi.fn(),
  sessionId: 'session-1',
  database: 'lagun_test',
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fileInput() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('file input missing')
  return input
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    format: 'csv',
    columns: ['name', 'status'],
    rows: [['Alice', 'active']],
    total_lines_sampled: 1,
    ...overrides,
  }
}

function success(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    rows_processed: 3,
    rows_imported: 3,
    method: 'csv',
    ...overrides,
  }
}

async function chooseOption(label: string, option: string) {
  await userEvent.click(screen.getByRole('button', { name: label }))
  await userEvent.click(screen.getByRole('option', { name: option }))
}

describe('ImportDialog setup and reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    importPreview.mockResolvedValue(preview())
    importFile.mockResolvedValue(success())
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('loads tables only while open and resets the wizard when reopened', async () => {
    const user = userEvent.setup()
    const view = render(<ImportDialog {...props} open={false} />)
    expect(mockLoadTables).not.toHaveBeenCalled()

    view.rerender(<ImportDialog {...props} />)
    await waitFor(() => expect(mockLoadTables).toHaveBeenCalledWith('session-1', 'lagun_test'))
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'users.csv', { type: 'text/csv' }))
    await chooseOption('Target Table', 'users')
    await user.click(screen.getByRole('checkbox', { name: 'First row contains column names' }))
    expect(screen.getByRole('button', { name: /Selected file users.csv/ })).toBeInTheDocument()

    view.rerender(<ImportDialog {...props} open={false} />)
    view.rerender(<ImportDialog {...props} />)

    expect(screen.getByRole('button', { name: 'Choose import file' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'First row contains column names' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Target Table' })).toHaveTextContent('Select table…')
  })

  it('uses a preselected target and switches to dump mode without a target table', async () => {
    render(<ImportDialog {...props} table="users" />)
    expect(screen.getByRole('dialog', { name: 'Import into lagun_test.users' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Target Table' })).toHaveTextContent('users')

    await chooseOption('File Format', 'MySQL dump (.sql / .dump)')
    expect(screen.getByRole('dialog', { name: 'Import MySQL dump into lagun_test' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Target Table' })).not.toBeInTheDocument()
    expect(screen.getByText(/execute SQL from the file/i)).toBeInTheDocument()
  })

  it('offers the loaded target tables', async () => {
    const user = userEvent.setup()
    render(<ImportDialog {...props} />)
    await user.click(screen.getByRole('button', { name: 'Target Table' }))

    const list = screen.getByRole('listbox', { name: 'Target Table' })
    expect(within(list).getByRole('option', { name: 'users' })).toBeInTheDocument()
    expect(within(list).getByRole('option', { name: 'orders' })).toBeInTheDocument()
  })

  it('falls back to an empty target list when the schema store has no entry', async () => {
    const user = userEvent.setup()
    render(<ImportDialog {...props} database="missing_db" />)
    await user.click(screen.getByRole('button', { name: 'Target Table' }))

    expect(screen.queryByRole('option', { name: 'users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'orders' })).not.toBeInTheDocument()
  })
})

describe('ImportDialog file selection and drop feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    importPreview.mockResolvedValue(preview())
    importFile.mockResolvedValue(success())
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('ignores empty selections and accepts dropped files', async () => {
    render(<ImportDialog {...props} />)
    const input = fileInput()

    fireEvent.change(input, { target: { files: [] } })
    expect(screen.getByRole('button', { name: 'Choose import file' })).toBeInTheDocument()

    const file = new File(['name\nAlice\n'], 'dropped.csv', { type: 'text/csv' })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    fireEvent(screen.getByRole('button', { name: 'Choose import file' }), drop)

    expect(drop.defaultPrevented).toBe(true)
    expect(screen.getByRole('button', { name: /Selected file dropped.csv/ })).toBeInTheDocument()
    expect(input.value).toBe('')
  })

  it('shows preparing, delayed, and dismissible drop feedback', () => {
    vi.useFakeTimers()
    render(<ImportDialog {...props} />)
    const dropZone = screen.getByRole('button', { name: 'Choose import file' })

    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()
    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.getByRole('status')).toHaveTextContent('Preparing upload…')
    act(() => vi.advanceTimersByTime(15_000))
    expect(screen.getByRole('status')).toHaveTextContent("Upload hasn't started yet.")

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('lets the delayed overlay choose a file', () => {
    vi.useFakeTimers()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    render(<ImportDialog {...props} />)
    fireEvent.dragOver(screen.getByRole('button', { name: 'Choose import file' }))
    act(() => vi.advanceTimersByTime(16_500))

    fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
    expect(click).toHaveBeenCalled()
  })

  it('opens the file picker from the drop zone', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    render(<ImportDialog {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose import file' }))
    expect(click).toHaveBeenCalledOnce()
  })

  it('clears an overlay timer that has not fired yet', () => {
    vi.useFakeTimers()
    render(<ImportDialog {...props} />)
    const dropZone = screen.getByRole('button', { name: 'Choose import file' })

    fireEvent.dragOver(dropZone)
    fireEvent.dragLeave(dropZone)
    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()
  })

  it('resets the preparing state when another drag starts', () => {
    vi.useFakeTimers()
    render(<ImportDialog {...props} />)
    const dropZone = screen.getByRole('button', { name: 'Choose import file' })

    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.getByText('Preparing upload…')).toBeInTheDocument()
    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_500))
    expect(screen.getByText('Preparing upload…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()
  })

  it('clears feedback on cleanup at each timer phase', () => {
    vi.useFakeTimers()
    const first = render(<ImportDialog {...props} />)
    fireEvent.dragOver(screen.getByRole('button', { name: 'Choose import file' }))
    first.unmount()

    const second = render(<ImportDialog {...props} />)
    fireEvent.dragOver(screen.getByRole('button', { name: 'Choose import file' }))
    act(() => vi.advanceTimersByTime(1_500))
    second.unmount()
  })

  it('does not clear feedback when the drag leaves a child element', () => {
    vi.useFakeTimers()
    render(<ImportDialog {...props} />)
    const dropZone = screen.getByRole('button', { name: 'Choose import file' })
    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_500))

    fireEvent.dragLeave(screen.getByText(/Drop a CSV/))
    expect(screen.getByText('Preparing upload…')).toBeInTheDocument()
  })

  it('clears pending feedback on drag leave, drop, dragend, blur, and hidden visibility', async () => {
    vi.useFakeTimers()
    render(<ImportDialog {...props} />)
    const dropZone = screen.getByRole('button', { name: 'Choose import file' })

    for (const event of [
      () => fireEvent.dragLeave(dropZone),
      () => fireEvent.drop(dropZone, { dataTransfer: { files: [] } }),
      () => fireEvent.dragEnd(dropZone),
      () => fireEvent.blur(window),
    ]) {
      fireEvent.dragOver(dropZone)
      act(() => vi.advanceTimersByTime(1_500))
      expect(screen.getByText('Preparing upload…')).toBeInTheDocument()
      event()
      expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()
    }

    fireEvent.dragOver(dropZone)
    act(() => vi.advanceTimersByTime(1_500))
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(screen.getByText('Preparing upload…')).toBeInTheDocument()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(screen.queryByText('Preparing upload…')).not.toBeInTheDocument()
  })
})

describe('ImportDialog preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    importPreview.mockResolvedValue(preview())
    importFile.mockResolvedValue(success())
  })

  it('previews a small file and renders sampled-row overflow', async () => {
    const user = userEvent.setup()
    importPreview.mockResolvedValueOnce(preview({ rows: [['Alice', 'active']], total_lines_sampled: 5 }))
    render(<ImportDialog {...props} table="users" />)
    const file = new File(['name,status\nAlice,active\n'], 'users.csv', { type: 'text/csv' })
    await user.upload(fileInput(), file)
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    const table = await screen.findByRole('table', { name: 'Import preview' })
    expect(within(table).getByRole('columnheader', { name: 'name' })).toBeInTheDocument()
    expect(within(table).getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 5+ rows')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh Preview' })).toBeInTheDocument()

    const form = importPreview.mock.calls[0][1] as FormData
    expect((form.get('file') as File).size).toBe(file.size)
    expect((form.get('file') as File).name).toBe('users.csv')
  })

  it('sends only the first 1 MB for a large preview and hides equal sample count', async () => {
    const user = userEvent.setup()
    render(<ImportDialog {...props} />)
    const file = new File([new Uint8Array(2 * 1024 * 1024)], 'large.csv', { type: 'text/csv' })
    await user.upload(fileInput(), file)
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Alice')

    expect(((importPreview.mock.calls[0][1] as FormData).get('file') as File).size).toBe(1024 * 1024)
    expect(screen.queryByText(/Showing .* rows/)).not.toBeInTheDocument()
  })

  it('previews MySQL dump statements and handles a missing statement list', async () => {
    const user = userEvent.setup()
    importPreview
      .mockResolvedValueOnce({
        format: 'mysql_dump',
        columns: [],
        rows: [],
        total_lines_sampled: 0,
        statements: [{ line: 3, sql: 'CREATE TABLE users (id INT)' }],
      })
      .mockResolvedValueOnce({
        format: 'mysql_dump',
        columns: [],
        rows: [],
        total_lines_sampled: 0,
      })
    render(<ImportDialog {...props} />)
    await user.upload(fileInput(), new File(['SELECT 1;'], 'dump.sql', { type: 'text/plain' }))
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText('CREATE TABLE users (id INT)')).toBeInTheDocument()
    expect(screen.getByText(/line 3:/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Refresh Preview' }))
    await waitFor(() => expect(importPreview).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Previewing up to 10 SQL statements')).toBeInTheDocument()
    expect(screen.queryByText(/line 3:/)).not.toBeInTheDocument()
  })

  it.each([
    [new Error('invalid CSV'), 'invalid CSV'],
    ['invalid CSV', 'invalid CSV'],
  ])('reports preview failures and allows retry', async (failure, expected) => {
    const user = userEvent.setup()
    importPreview.mockRejectedValueOnce(failure)
    render(<ImportDialog {...props} />)
    await user.upload(fileInput(), new File(['bad'], 'bad.csv'))
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(screen.getByRole('button', { name: 'Preview' })).toBeEnabled()
  })

  it('shows a loading preview and discards a preview made stale by a config change', async () => {
    const user = userEvent.setup()
    const gate = deferred<ReturnType<typeof preview>>()
    importPreview.mockImplementationOnce(() => gate.promise)
    render(<ImportDialog {...props} />)
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'users.csv'))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByText('Reading file preview…')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'CSV Format Options' }))
    await chooseOption('Delimiter', 'Semicolon (;)')
    gate.resolve(preview())

    await waitFor(() => expect(screen.queryByText('Reading file preview…')).not.toBeInTheDocument())
    expect(screen.queryByRole('table', { name: 'Import preview' })).not.toBeInTheDocument()
  })

  it('discards a stale preview failure', async () => {
    const user = userEvent.setup()
    const gate = deferred<ReturnType<typeof preview>>()
    importPreview.mockImplementationOnce(() => gate.promise)
    render(<ImportDialog {...props} />)
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'users.csv'))
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await user.click(screen.getByRole('button', { name: 'CSV Format Options' }))
    await chooseOption('Delimiter', 'Semicolon (;)')
    await act(async () => gate.reject(new Error('old preview failed')))

    expect(screen.queryByText('old preview failed')).not.toBeInTheDocument()
  })
})

describe('ImportDialog import execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    importPreview.mockResolvedValue(preview())
    importFile.mockResolvedValue(success())
  })

  it('imports CSV with the entered options and reports success', async () => {
    const user = userEvent.setup()
    const onImportComplete = vi.fn()
    render(<ImportDialog {...props} table="users" onImportComplete={onImportComplete} />)
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'users.csv', { type: 'text/csv' }))
    await chooseOption('Import Strategy', 'REPLACE INTO (overwrite)')
    await user.click(screen.getByRole('checkbox', { name: 'First row contains column names' }))
    await user.click(screen.getByRole('button', { name: 'CSV Format Options' }))
    await chooseOption('Delimiter', 'Custom')
    await user.type(screen.getByRole('textbox', { name: 'Custom' }), ';ignored')
    await chooseOption('Quote Character', 'Single Quote (\')')
    await chooseOption('Escape Character', 'Backslash (\\)')
    await chooseOption('Encoding', 'UTF-8 with BOM')
    await user.click(screen.getByRole('checkbox', { name: /Preserve blank fields/ }))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(onImportComplete).toHaveBeenCalledOnce())
    const form = importFile.mock.calls[0][1] as FormData
    expect(JSON.parse(String(form.get('config')))).toEqual({
      database: 'lagun_test',
      format: 'csv',
      table: 'users',
      delimiter: ';',
      quotechar: "'",
      escapechar: '\\\\',
      encoding: 'utf-8-sig',
      first_row_header: false,
      strategy: 'replace',
      preserve_empty_strings: true,
    })
    expect(screen.getByRole('status')).toHaveTextContent('Imported 3 rows via batch insert.')
    expect(importFile.mock.calls[0][2]).toEqual(expect.any(Function))
  })

  it('imports a dump without an optional completion callback', async () => {
    const user = userEvent.setup()
    importFile.mockResolvedValueOnce(success({
      method: 'mysql_dump',
      statements_processed: 3,
      statements_succeeded: 2,
      rows_imported: 8,
    }))
    render(<ImportDialog {...props} />)
    await chooseOption('File Format', 'MySQL dump (.sql / .dump)')
    await user.upload(fileInput(), new File(['SELECT 1;'], 'dump.sql'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(/Executed 2 of 3 dump statements; 8 affected rows/)).toBeInTheDocument()
    expect(JSON.parse(String((importFile.mock.calls[0][1] as FormData).get('config')))).toEqual({
      database: 'lagun_test',
      format: 'mysql_dump',
    })
  })

  it('uses zero for missing dump statement counters', async () => {
    const user = userEvent.setup()
    importFile.mockResolvedValueOnce(success({ method: 'mysql_dump' }))
    render(<ImportDialog {...props} />)
    await chooseOption('File Format', 'MySQL dump (.sql / .dump)')
    await user.upload(fileInput(), new File(['SELECT 1;'], 'dump.sql'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(/Executed 0 of 0 dump statements; 3 affected rows/)).toBeInTheDocument()
  })

  it('shows a targetless dump import phase without a target suffix', async () => {
    const user = userEvent.setup()
    const gate = deferred<ReturnType<typeof success>>()
    importFile.mockImplementationOnce(() => gate.promise)
    render(<ImportDialog {...props} />)
    await chooseOption('File Format', 'MySQL dump (.sql / .dump)')
    await user.upload(fileInput(), new File(['SELECT 1;'], 'dump.sql'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(screen.getByText('Importing dump.sql into lagun_test. The server is processing the file; large imports can take a while.')).toBeInTheDocument()
    await act(async () => gate.resolve(success()))
  })

  it('reports upload progress, clamps it, and falls back to indeterminate phases', async () => {
    const user = userEvent.setup()
    const gate = deferred<ReturnType<typeof success>>()
    let report: ((progress: { loaded: number; total: number } | null) => void) | undefined
    importFile.mockImplementationOnce((_sessionId, _form, onProgress) => {
      report = onProgress
      return gate.promise
    })
    render(<ImportDialog {...props} table="users" />)
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'rows.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(screen.getByRole('progressbar', { name: 'Importing' })).not.toHaveAttribute('aria-valuenow')
    act(() => report?.(null))
    expect(screen.getByRole('progressbar', { name: 'Importing' })).not.toHaveAttribute('aria-valuenow')
    act(() => report?.({ loaded: 10, total: 0 }))
    expect(screen.getByRole('progressbar', { name: 'Importing' })).not.toHaveAttribute('aria-valuenow')
    act(() => report?.({ loaded: -10, total: 100 }))
    expect(screen.getByRole('progressbar', { name: 'Uploading file' })).toHaveAttribute('aria-valuenow', '0')
    act(() => report?.({ loaded: 30, total: 120 }))
    expect(screen.getByText('Uploading rows.csv… 25%')).toBeInTheDocument()
    act(() => report?.({ loaded: 500, total: 100 }))
    expect(screen.getByRole('progressbar', { name: 'Uploading file' })).toHaveAttribute('aria-valuenow', '100')

    await act(async () => gate.resolve(success({ rows_imported: 1 })))
    expect(await screen.findByText('Imported 1 rows via batch insert.')).toBeInTheDocument()
  })

  it.each([
    [new Error('import failed'), 'Error: import failed'],
    ['import failed', 'import failed'],
  ])('reports import failures and offers retry', async (failure, expected) => {
    const user = userEvent.setup()
    importFile.mockRejectedValueOnce(failure)
    render(<ImportDialog {...props} table="users" />)
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'users.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(`Import failed: ${expected}`)
    expect(screen.getByRole('button', { name: 'Retry Import' })).toBeInTheDocument()
  })

  it('blocks closing while importing and ignores stale progress and completion', async () => {
    const user = userEvent.setup()
    const gate = deferred<ReturnType<typeof success>>()
    let report: ((progress: { loaded: number; total: number } | null) => void) | undefined
    importFile.mockImplementationOnce((_sessionId, _form, onProgress) => {
      report = onProgress
      return gate.promise
    })
    const onClose = vi.fn()
    const onImportComplete = vi.fn()
    const view = render(
      <ImportDialog {...props} table="users" onClose={onClose} onImportComplete={onImportComplete} />,
    )
    await user.upload(fileInput(), new File(['name\nAlice\n'], 'users.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    view.rerender(
      <ImportDialog {...props} table="users" onClose={onClose} onImportComplete={onImportComplete} open={false} />,
    )
    act(() => report?.({ loaded: 1, total: 2 }))
    await act(async () => gate.resolve(success()))

    expect(onImportComplete).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores a stale import rejection', async () => {
    const user = userEvent.setup()
    const gate = deferred<ReturnType<typeof success>>()
    importFile.mockImplementationOnce(() => gate.promise)
    const view = render(<ImportDialog {...props} table="users" />)
    await user.upload(fileInput(), new File(['x'], 'x.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))
    view.rerender(<ImportDialog {...props} table="users" open={false} />)
    await act(async () => gate.reject(new Error('late failure')))
    expect(screen.queryByText(/late failure/)).not.toBeInTheDocument()
  })

  it('closes normally after a file is selected', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<ImportDialog {...props} onClose={onClose} />)
    await user.upload(fileInput(), new File(['x'], 'x.csv'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('ImportDialog result banners', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    importPreview.mockResolvedValue(preview())
  })

  it('shows up to five warnings and a remaining count', async () => {
    const user = userEvent.setup()
    importFile.mockResolvedValueOnce(success({
      warnings: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'],
    }))
    render(<ImportDialog {...props} table="users" />)
    await user.upload(fileInput(), new File(['x'], 'x.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('one')
    expect(status).toHaveTextContent('five')
    expect(status).not.toHaveTextContent('six')
    expect(status).toHaveTextContent('…and 2 more')
  })

  it('shows five warnings without a remaining count', async () => {
    const user = userEvent.setup()
    importFile.mockResolvedValueOnce(success({
      warnings: ['one', 'two', 'three', 'four', 'five'],
    }))
    render(<ImportDialog {...props} table="users" />)
    await user.upload(fileInput(), new File(['x'], 'x.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('five')
    expect(status).not.toHaveTextContent('more')
  })

  it('shows partial failure, source line, and failing statement', async () => {
    const user = userEvent.setup()
    importFile.mockResolvedValueOnce({
      ok: false,
      rows_processed: 2,
      rows_imported: 1,
      method: 'mysql_dump',
      error: 'syntax error',
      partial: true,
      error_line: 0,
      error_statement: 'INSERT INTO broken',
    })
    render(<ImportDialog {...props} />)
    await chooseOption('File Format', 'MySQL dump (.sql / .dump)')
    await user.upload(fileInput(), new File(['broken'], 'broken.sql'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Import failed after partial execution: syntax error')
    expect(alert).toHaveTextContent('Source line: 0')
    expect(alert).toHaveTextContent('INSERT INTO broken')
  })

  it('omits absent failure details', async () => {
    const user = userEvent.setup()
    importFile.mockResolvedValueOnce({
      ok: false,
      rows_processed: 0,
      rows_imported: 0,
      method: 'csv',
      error: 'bad row',
      partial: false,
      error_line: null,
      error_statement: '',
    })
    render(<ImportDialog {...props} table="users" />)
    await user.upload(fileInput(), new File(['x'], 'x.csv'))
    await user.click(screen.getByRole('button', { name: 'Import' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Import failed: bad row')
    expect(alert).not.toHaveTextContent('Source line')
  })
})
