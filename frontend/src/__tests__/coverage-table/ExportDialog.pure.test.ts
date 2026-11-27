import { describe, expect, it, vi } from 'vitest'
import {
  buildFrontendContent,
  buildQualifiedTableName,
  exportFilename,
  formatExportBytes,
  neutralizeCsvCell,
  responseBlobWithProgress,
  responseTextWithLimit,
} from '../../components/table/ExportDialog'

const DB = 'db'
const TBL = 'tbl'
const opts = {
  delimiter: ',',
  quoteChar: '"',
  escapeChar: '"',
  lineTerminator: '\r\n',
  encoding: 'utf-8',
}

function csv(
  columns: string[],
  rows: unknown[][],
  overrides: Partial<typeof opts> = {},
  includeAutoIncrement = true,
) {
  return buildFrontendContent(
    'csv',
    DB,
    TBL,
    { columns, rows },
    [],
    { ...opts, ...overrides },
    'batch',
    false,
    includeAutoIncrement,
  )
}

function insert(
  columns: string[],
  rows: unknown[][],
  mode: 'batch' | 'single' = 'single',
  includeSchema = false,
) {
  return buildFrontendContent(
    'insert',
    DB,
    TBL,
    { columns, rows },
    [],
    opts,
    mode,
    includeSchema,
  )
}

function deleteInsert(
  columns: string[],
  rows: unknown[][],
  pkCols: string[],
  mode: 'batch' | 'single' = 'single',
) {
  return buildFrontendContent(
    'delete+insert',
    DB,
    TBL,
    { columns, rows },
    pkCols,
    opts,
    mode,
  )
}

describe('CSV cell neutralization', () => {
  it('leaves null, undefined, empty, and ordinary text alone', () => {
    expect(neutralizeCsvCell(null)).toBe('')
    expect(neutralizeCsvCell(undefined)).toBe('')
    expect(neutralizeCsvCell('')).toBe('')
    expect(neutralizeCsvCell('Alice')).toBe('Alice')
    expect(neutralizeCsvCell('a=b')).toBe('a=b')
  })

  it.each(['=1+1', '+SUM(A1)', '@cmd', '-2+3', '\t=1+1', '\r=1+1', '\t', '\r'])(
    'neutralizes formula-leading value %j',
    (value) => {
      expect(neutralizeCsvCell(value)).toBe(`'${value}`)
    },
  )

  it.each(['-5', '+1.5', '-1e6', 1.5, -7])('keeps numeric value %j', (value) => {
    expect(neutralizeCsvCell(value)).toBe(String(value))
  })
})

describe('qualified names and SQL literals', () => {
  it('quotes table identifiers with and without a schema', () => {
    expect(buildQualifiedTableName('db', 'tbl')).toBe('`tbl`')
    expect(buildQualifiedTableName('db', 'tbl', true)).toBe('`db`.`tbl`')
    expect(buildQualifiedTableName('d`b', 't`bl', true)).toBe('`d``b`.`t``bl`')
  })

  it('writes NULL, numbers, bigints, escaped text, and hex-safe text', () => {
    const values = [
      null,
      undefined,
      12,
      BigInt(13),
      "it's",
      'C:\\Users\\test',
      'nul\u0000byte',
      'sub\u001abyte',
    ]
    const out = insert(['v'], [values], 'batch')

    expect(out).toContain('(NULL, NULL, 12, 13, ')
    expect(out).toContain("'it''s'")
    for (const value of ['C:\\Users\\test', 'nul\u0000byte', 'sub\u001abyte']) {
      const hex = Array.from(new TextEncoder().encode(value))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
      expect(out).toContain(`CONVERT(0x${hex} USING utf8mb4)`)
    }
    expect(out).toContain('`v`')
  })

  it('quotes backticks inside column names', () => {
    const out = insert(['we`ird'], [['value']])
    expect(out).toContain('(`we``ird`)')
  })
})

describe('JSON export', () => {
  it('maps rows to objects, preserves false and empty, and fills missing cells with null', () => {
    const out = buildFrontendContent(
      'json',
      DB,
      TBL,
      {
        columns: ['id', 'name', 'enabled', 'missing'],
        rows: [[7, 'O"Reilly', false], [8, '', null]],
      },
      [],
      opts,
    )

    expect(JSON.parse(out)).toEqual([
      { id: 7, name: 'O"Reilly', enabled: false, missing: null },
      { id: 8, name: '', enabled: null, missing: null },
    ])
  })
})

describe('CSV serialization', () => {
  it('quotes headers, escapes quotes, and only quotes data when needed', () => {
    const out = csv(['Price "USD"', 'plain'], [['say "hi"', 'ok']])
    expect(out.split('\r\n')[0]).toBe('"Price ""USD""","plain"')
    expect(out.split('\r\n')[1]).toBe('"say ""hi""",ok')
  })

  it.each([
    ['a,b', '"a,b"'],
    ['line1\nline2', '"line1\nline2"'],
    ['line1\rline2', '"line1\rline2"'],
    ['"quoted"', '"""quoted"""'],
  ])('quotes a data value containing %j', (value, expected) => {
    expect(csv(['col'], [[value]]).split('\r\n')[1]).toBe(expected)
  })

  it('supports a separate escape character and self-escapes it', () => {
    const out = csv(
      [String.raw`Col\Name`],
      [[String.raw`C:\Users\test`], [String.raw`path \"escaped\"`]],
      { escapeChar: '\\' },
    )
    expect(out.split('\r\n')[0]).toBe('"Col\\\\Name"')
    expect(out.split('\r\n')[1]).toBe('"C:\\\\Users\\\\test"')
    expect(out.split('\r\n')[2]).toBe('"path \\\\\\"escaped\\\\\\""')
  })

  it('handles an escape character match, quote-character match, and no special characters', () => {
    expect(csv(['col'], [['a\\b']], { escapeChar: '\\' }).split('\r\n')[1]).toBe('"a\\\\b"')
    expect(csv(['col'], [["a'b"]], { quoteChar: "'" }).split('\r\n')[1]).toBe(`'a"'b'`)
    expect(csv(['col'], [['plain']]).split('\r\n')[1]).toBe('plain')
  })

  it('supports QUOTE_NONE with a separate escape character', () => {
    const noQuote = { quoteChar: '', escapeChar: '\\' }
    expect(csv(['col'], [['hello world']], noQuote).split('\r\n')[1]).toBe('hello world')
    expect(csv(['col'], [[String.raw`C:\path`]], noQuote).split('\r\n')[1]).toBe('C:\\\\path')
    expect(csv(['col'], [['a,b']], noQuote).split('\r\n')[1]).toBe('a\\,b')
    expect(csv(['col'], [['a\r\nb']], noQuote)).toBe('col\r\na\\\r\nb')
    expect(csv(['col'], [['a\rb']], noQuote).split('\r\n')[1]).toBe('a\\\rb')
    expect(csv(['col'], [['a\nb']], noQuote).split('\r\n')[1]).toBe('a\\\nb')
  })

  it('supports QUOTE_NONE without an escape character', () => {
    expect(csv(['myCol'], [['hello,world']], { quoteChar: '', escapeChar: '' })).toBe(
      'myCol\r\nhello,world',
    )
  })

  it('supports a BOM and leaves UTF-8 without one', () => {
    expect(csv(['c'], [['v']], { encoding: 'utf-8-sig' }).charCodeAt(0)).toBe(0xFEFF)
    expect(csv(['c'], [['v']]).charCodeAt(0)).not.toBe(0xFEFF)
  })

  it('filters auto-increment columns from headers and rows', () => {
    const out = buildFrontendContent(
      'csv',
      DB,
      TBL,
      { columns: ['id', 'name'], rows: [[1, 'A']], autoIncrementColumns: ['id'] },
      [],
      opts,
      'batch',
      false,
      false,
    )
    expect(out).toBe('"name"\r\nA')
  })

  it('keeps auto-increment columns when the flag is included', () => {
    const out = buildFrontendContent(
      'csv',
      DB,
      TBL,
      { columns: ['id', 'name'], rows: [[1, 'A']], autoIncrementColumns: ['id'] },
      [],
      opts,
      'batch',
      false,
      true,
    )
    expect(out).toBe('"id","name"\r\n1,A')
  })
})

describe('INSERT serialization', () => {
  it('writes batch and single INSERTs and optionally includes the schema', () => {
    expect(insert(['id', 'name'], [[1, 'Alice'], [2, 'Bob']], 'batch')).toBe(
      "INSERT INTO `tbl` (`id`, `name`) VALUES\n(1, 'Alice'),\n(2, 'Bob');\n",
    )
    expect(insert(['id'], [[1]], 'single', true)).toBe(
      "INSERT INTO `db`.`tbl` (`id`) VALUES (1);\n",
    )
  })

  it('filters auto-increment columns in both insert modes', () => {
    const data = { columns: ['id', 'name'], rows: [[1, 'A']], autoIncrementColumns: ['id'] }
    expect(
      buildFrontendContent('insert', DB, TBL, data, [], opts, 'single', false, false),
    ).toBe("INSERT INTO `tbl` (`name`) VALUES ('A');\n")
    expect(
      buildFrontendContent('insert', DB, TBL, data, [], opts, 'batch', false, false),
    ).toBe("INSERT INTO `tbl` (`name`) VALUES\n('A');\n")
  })
})

describe('DELETE and DELETE+INSERT serialization', () => {
  it('uses NULL predicates and falls back to all columns when no PK is supplied', () => {
    expect(
      buildFrontendContent(
        'delete',
        DB,
        TBL,
        { columns: ['id', 'name'], rows: [[null, 'x']] },
        [],
        opts,
      ),
    ).toBe('DELETE FROM `tbl` WHERE `id` IS NULL AND `name` = \'x\';\n')
    expect(
      buildFrontendContent(
        'delete',
        DB,
        TBL,
        { columns: ['id'], rows: [[]] },
        ['id'],
        opts,
      ),
    ).toBe('DELETE FROM `tbl` WHERE `id` IS NULL;\n')
    expect(
      buildFrontendContent(
        'delete',
        DB,
        TBL,
        { columns: ['id'], rows: [[1]] },
        ['missing'],
        opts,
      ),
    ).toBe('DELETE FROM `tbl` WHERE `missing` IS NULL;\n')
  })

  it('writes batch and single DELETE+INSERT, with schema support', () => {
    expect(deleteInsert(['id', 'name'], [[1, 'A'], [2, 'B']], ['id'], 'batch')).toBe(
      'DELETE FROM `tbl` WHERE `id` = 1;\n' +
      'DELETE FROM `tbl` WHERE `id` = 2;\n\n' +
      "INSERT INTO `tbl` (`id`, `name`) VALUES\n(1, 'A'),\n(2, 'B');\n",
    )
    expect(deleteInsert(['id'], [[1]], ['id'], 'single')).toBe(
      'DELETE FROM `tbl` WHERE `id` = 1;\nINSERT INTO `tbl` (`id`) VALUES (1);\n',
    )
    expect(
      buildFrontendContent(
        'delete+insert',
        DB,
        TBL,
        { columns: ['id'], rows: [[1]] },
        ['missing'],
        opts,
        'single',
        true,
      ),
    ).toBe('DELETE FROM `db`.`tbl` WHERE `missing` IS NULL;\nINSERT INTO `db`.`tbl` (`id`) VALUES (1);\n')
  })

  it('keeps primary-key predicates while filtering auto-increment insert columns', () => {
    const data = {
      columns: ['id', 'name'],
      rows: [[1, 'A']],
      autoIncrementColumns: ['id'],
    }
    expect(
      buildFrontendContent('delete+insert', DB, TBL, data, ['id'], opts, 'single', false, false),
    ).toBe("DELETE FROM `tbl` WHERE `id` = 1;\nINSERT INTO `tbl` (`name`) VALUES ('A');\n")
    expect(
      buildFrontendContent('delete+insert', DB, TBL, data, ['id'], opts, 'batch', false, false),
    ).toBe("DELETE FROM `tbl` WHERE `id` = 1;\n\nINSERT INTO `tbl` (`name`) VALUES\n('A');\n")
  })
})

describe('response helpers', () => {
  it('sizes exports in bytes, kilobytes, and megabytes', () => {
    expect(formatExportBytes(12)).toBe('12 B')
    expect(formatExportBytes(2048)).toBe('2.0 KB')
    expect(formatExportBytes(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  it('reads a bodyless response under and over the copy limit', async () => {
    await expect(responseTextWithLimit(new Response(null), 16)).resolves.toBe('')
    const oversized = {
      body: null,
      text: async () => 'too large',
    } as unknown as Response
    await expect(responseTextWithLimit(oversized, 4)).rejects.toThrow('Copy is limited')
  })

  it('reads a streamed response below the copy limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('small'))
        controller.close()
      },
    })
    await expect(responseTextWithLimit(new Response(stream), 16)).resolves.toBe('small')
  })

  it('cancels a streamed response above the copy limit', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('too large'))
      },
      cancel,
    })
    await expect(responseTextWithLimit(new Response(stream), 4)).rejects.toThrow('Copy is limited')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('reads a bodyless blob response with the declared and fallback content types', async () => {
    const progress = vi.fn()
    const typed = await responseBlobWithProgress(new Response(null, {
      headers: { 'Content-Type': 'text/plain' },
    }), progress)
    expect(progress).toHaveBeenCalledWith(0)
    expect(typed.blob.type).toBe('text/plain')
    expect(typed.tail).toBe('')

    const fallback = {
      headers: new Headers(),
      body: null,
      text: async () => 'abc',
    } as unknown as Response
    const result = await responseBlobWithProgress(fallback)
    expect(result.blob.type).toBe('application/octet-stream')
    expect(result.tail).toBe('abc')
  })

  it('streams a blob with progress and keeps only the tail', async () => {
    const progress = vi.fn()
    const payload = new Uint8Array(70_000).fill(65)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload)
        controller.close()
      },
    })
    const result = await responseBlobWithProgress(
      new Response(stream, { headers: { 'Content-Type': 'application/pdf' } }),
      progress,
    )

    expect(result.blob.size).toBe(payload.length)
    expect(result.blob.type).toBe('application/pdf')
    expect(result.tail).toHaveLength(64 * 1024)
    expect(progress).toHaveBeenNthCalledWith(1, 0)
    expect(progress).toHaveBeenLastCalledWith(payload.length)
  })

  it('accepts a streamed response without a progress callback or content type', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abc'))
        controller.close()
      },
    })
    const response = new Response(stream)
    response.headers.delete('Content-Type')
    const result = await responseBlobWithProgress(response)

    expect(result.blob.size).toBe(3)
    expect(result.blob.type).toBe('application/octet-stream')
    expect(result.tail).toBe('abc')
  })

  it('reads a server filename or falls back when absent', () => {
    expect(exportFilename(new Response('', {
      headers: { 'Content-Disposition': 'attachment; filename="users.sql"' },
    }), 'fallback.sql')).toBe('users.sql')
    expect(exportFilename(new Response(''), 'fallback.sql')).toBe('fallback.sql')
  })
})
