import { describe, it, expect } from 'vitest'
import { buildFrontendContent } from '../../components/table/ExportDialog'

const DB = 'db'
const TBL = 'tbl'
const PK: string[] = []

function csv(
  columns: string[],
  rows: unknown[][],
  opts: Partial<{ delimiter: string; quoteChar: string; escapeChar: string; lineTerminator: string; encoding: string }> = {},
): string {
  return buildFrontendContent('csv', DB, TBL, { columns, rows }, PK, {
    delimiter: opts.delimiter ?? ',',
    quoteChar: opts.quoteChar ?? '"',
    escapeChar: opts.escapeChar ?? '"',
    lineTerminator: opts.lineTerminator ?? '\r\n',
    encoding: opts.encoding ?? 'utf-8',
  })
}

describe('escape() — quoting triggers', () => {
  it('plain value not quoted, header always quoted', () => {
    const out = csv(['a'], [['hello']])
    const [header, data] = out.split('\r\n')
    expect(header).toBe('"a"')   // headers always quoted (consistent with backend QUOTE_ALL)
    expect(data).toBe('hello')   // data cells only quoted when needed
  })

  it('comma in value triggers quoting', () => {
    const out = csv(['col'], [['a,b']])
    expect(out).toContain('"a,b"')
  })

  it('LF in value triggers quoting', () => {
    const out = csv(['col'], [['line1\nline2']])
    expect(out).toContain('"line1\nline2"')
  })

  it('CR in value triggers quoting (the fix)', () => {
    const out = csv(['col'], [['line1\rline2']])
    expect(out).toContain('"line1\rline2"')
  })

  it('CRLF in value triggers quoting', () => {
    const out = csv(['col'], [['line1\r\nline2']])
    expect(out).toContain('"line1\r\nline2"')
  })

  it('quotechar in value triggers quoting and escapes it', () => {
    const out = csv(['col'], [['say "hi"']])
    expect(out).toContain('"say ""hi"""')
  })
})

describe('escape() — double-quote mode (default)', () => {
  it('embedded quote doubled', () => {
    const out = csv(['col'], [['"quoted"']])
    expect(out).toContain('"""quoted"""')
  })

  it('null → empty string', () => {
    const out = csv(['col'], [[null]])
    const dataLine = out.split('\r\n')[1]
    expect(dataLine).toBe('')
  })

  it('undefined → empty string', () => {
    const out = csv(['col'], [[undefined]])
    const dataLine = out.split('\r\n')[1]
    expect(dataLine).toBe('')
  })
})

describe('escape() — backslash escapechar mode', () => {
  const opts = { quoteChar: '"', escapeChar: '\\' }

  it('embedded quote escaped with backslash, not doubled', () => {
    const out = csv(['col'], [['say "hi"']], opts)
    // Field must be "say \"hi\"" — backslash before each embedded quote.
    // Note: "" can appear where \"  meets the closing " of the field; that is
    // unavoidable and correct, not a sign of double-quote escaping.
    expect(out).toContain('\\"')
    expect(out.split('\r\n')[1]).toBe('"say \\"hi\\""')
  })

  it('backslash in value is self-escaped (the blocker fix)', () => {
    const out = csv(['col'], [[String.raw`C:\Users\test`]], opts)
    // Backslash must be doubled so a backslash-mode reader decodes \\→\ correctly.
    expect(out.split('\r\n')[1]).toBe('"C:\\\\Users\\\\test"')
  })

  it('backslash + quote in value — escapechar self-escaped before quotechar escape', () => {
    // path \"escaped\" → first double backslashes, then escape quotes
    // \ → \\, " → \"  giving: path \\"escaped\\"
    const out = csv(['col'], [[String.raw`path \"escaped\"`]], opts)
    expect(out.split('\r\n')[1]).toBe('"path \\\\\\"escaped\\\\\\""')
  })
})

describe('header escaping', () => {
  it('column name with quotechar is escaped (the fix)', () => {
    const out = csv(['Price "USD"'], [['1.00']])
    // Header should be "Price ""USD""" not "Price "USD""
    expect(out.split('\r\n')[0]).toBe('"Price ""USD"""')
  })

  it('column name with backslash escaped in backslash mode', () => {
    const out = csv([String.raw`Col\Name`], [['val']], { quoteChar: '"', escapeChar: '\\' })
    // Col\Name → Col\\Name after self-escaping, then wrapped in quotes
    expect(out.split('\r\n')[0]).toBe('"Col\\\\Name"')
  })

  it('column name with delimiter is quoted', () => {
    const out = csv(['col,with,commas'], [['val']])
    expect(out.split('\r\n')[0]).toBe('"col,with,commas"')
  })

  it('no quoteChar — header returned raw', () => {
    const out = csv(['myCol'], [['val']], { quoteChar: '' })
    expect(out.split('\r\n')[0]).toBe('myCol')
  })
})

describe('no-quoteChar path', () => {
  it('plain value returned raw — no escapeChar set', () => {
    const out = csv(['col'], [['hello world']], { quoteChar: '', escapeChar: '' })
    expect(out.split('\r\n')[1]).toBe('hello world')
  })

  it('delimiter escaped with escapeChar (the QUOTE_NONE fix)', () => {
    const out = csv(['col'], [['a,b']], { quoteChar: '', escapeChar: '\\' })
    expect(out.split('\r\n')[1]).toBe('a\\,b')
  })

  it('newline escaped with escapeChar', () => {
    const out = csv(['col'], [['line1\nline2']], { quoteChar: '', escapeChar: '\\' })
    expect(out.split('\r\n')[1]).toBe('line1\\\nline2')
  })

  it('CR escaped with escapeChar', () => {
    const out = csv(['col'], [['line1\rline2']], { quoteChar: '', escapeChar: '\\' })
    expect(out.split('\r\n')[1]).toBe('line1\\\rline2')
  })

  it('escapeChar self-escaped', () => {
    const out = csv(['col'], [[String.raw`C:\path`]], { quoteChar: '', escapeChar: '\\' })
    expect(out.split('\r\n')[1]).toBe('C:\\\\path')
  })

  it('no escapeChar set — value returned raw even with delimiter', () => {
    const out = csv(['col'], [['hello,world']], { quoteChar: '', escapeChar: '' })
    expect(out.split('\r\n')[1]).toBe('hello,world')
  })
})

describe('encoding', () => {
  it('utf-8-sig prepends BOM', () => {
    const out = csv(['col'], [['val']], { encoding: 'utf-8-sig' })
    expect(out.charCodeAt(0)).toBe(0xFEFF)
  })

  it('utf-8 does not prepend BOM', () => {
    const out = csv(['col'], [['val']], { encoding: 'utf-8' })
    expect(out.charCodeAt(0)).not.toBe(0xFEFF)
  })
})

function insert(
  columns: string[],
  rows: unknown[][],
  insertMode: 'batch' | 'single' = 'single',
  includeSchema = false,
): string {
  return buildFrontendContent('insert', DB, TBL, { columns, rows }, PK, {
    delimiter: ',',
    quoteChar: '"',
    escapeChar: '"',
    lineTerminator: '\r\n',
    encoding: 'utf-8',
  }, insertMode, includeSchema)
}

function deleteInsert(
  columns: string[],
  rows: unknown[][],
  pkCols: string[],
  insertMode: 'batch' | 'single' = 'single',
  includeSchema = false,
): string {
  return buildFrontendContent('delete+insert', DB, TBL, { columns, rows }, pkCols, {
    delimiter: ',',
    quoteChar: '"',
    escapeChar: '"',
    lineTerminator: '\r\n',
    encoding: 'utf-8',
  }, insertMode, includeSchema)
}

describe('insert format', () => {
  it('batch mode — all rows in one INSERT', () => {
    const out = insert(['id', 'name'], [[1, 'Alice'], [2, 'Bob']], 'batch')
    expect(out).toBe('INSERT INTO `tbl` (`id`, `name`) VALUES\n(1, \'Alice\'),\n(2, \'Bob\');\n')
  })

  it('single mode — one INSERT per row', () => {
    const out = insert(['id', 'name'], [[1, 'Alice'], [2, 'Bob']], 'single')
    expect(out).toBe(
      "INSERT INTO `tbl` (`id`, `name`) VALUES (1, 'Alice');\n" +
      "INSERT INTO `tbl` (`id`, `name`) VALUES (2, 'Bob');\n"
    )
  })

  it('includes schema when requested', () => {
    const out = insert(['id', 'name'], [[1, 'Alice']], 'single', true)
    expect(out).toBe("INSERT INTO `db`.`tbl` (`id`, `name`) VALUES (1, 'Alice');\n")
  })

  it('escapes single quotes in values', () => {
    const out = insert(['name'], [["it's"]], 'batch')
    expect(out).toContain("'it''s'")
  })

  it('handles null values', () => {
    const out = insert(['id', 'name'], [[1, null]], 'batch')
    expect(out).toContain('NULL')
  })
})

describe('delete format', () => {
  it('produces one DELETE per row using PK', () => {
    const out = buildFrontendContent('delete', DB, TBL, { columns: ['id', 'name'], rows: [[1, 'Alice'], [2, 'Bob']] }, ['id'], {
      delimiter: ',',
      quoteChar: '"',
      escapeChar: '"',
      lineTerminator: '\r\n',
      encoding: 'utf-8',
    })
    expect(out).toBe(
      'DELETE FROM `tbl` WHERE `id` = 1;\n' +
      'DELETE FROM `tbl` WHERE `id` = 2;\n'
    )
  })

  it('uses IS NULL for null primary-key values', () => {
    const out = buildFrontendContent('delete', DB, TBL, { columns: ['id', 'name'], rows: [[null, 'missing']] }, ['id'], {
      delimiter: ',',
      quoteChar: '"',
      escapeChar: '"',
      lineTerminator: '\r\n',
      encoding: 'utf-8',
    })
    expect(out).toBe('DELETE FROM `tbl` WHERE `id` IS NULL;\n')
  })

  it('includes schema when requested', () => {
    const out = buildFrontendContent('delete', DB, TBL, { columns: ['id', 'name'], rows: [[1, 'Alice']] }, ['id'], {
      delimiter: ',',
      quoteChar: '"',
      escapeChar: '"',
      lineTerminator: '\r\n',
      encoding: 'utf-8',
    }, 'single', true)
    expect(out).toBe('DELETE FROM `db`.`tbl` WHERE `id` = 1;\n')
  })
})

describe('delete+insert format', () => {
  it('batch mode — one DELETE per row + one INSERT for the batch', () => {
    const out = deleteInsert(['id', 'name'], [[1, 'Alice'], [2, 'Bob']], ['id'], 'batch')
    expect(out).toBe(
      'DELETE FROM `tbl` WHERE `id` = 1;\n' +
      'DELETE FROM `tbl` WHERE `id` = 2;\n' +
      '\n' +
      'INSERT INTO `tbl` (`id`, `name`) VALUES\n' +
      "(1, 'Alice'),\n" +
      "(2, 'Bob');\n"
    )
  })

  it('single mode — one DELETE + one INSERT per row', () => {
    const out = deleteInsert(['id', 'name'], [[1, 'Alice'], [2, 'Bob']], ['id'], 'single')
    expect(out).toBe(
      'DELETE FROM `tbl` WHERE `id` = 1;\n' +
      "INSERT INTO `tbl` (`id`, `name`) VALUES (1, 'Alice');\n" +
      'DELETE FROM `tbl` WHERE `id` = 2;\n' +
      "INSERT INTO `tbl` (`id`, `name`) VALUES (2, 'Bob');\n"
    )
  })

  it('includes schema when requested', () => {
    const out = deleteInsert(['id', 'name'], [[1, 'Alice']], ['id'], 'single', true)
    expect(out).toBe(
      'DELETE FROM `db`.`tbl` WHERE `id` = 1;\n' +
      "INSERT INTO `db`.`tbl` (`id`, `name`) VALUES (1, 'Alice');\n"
    )
  })
})
