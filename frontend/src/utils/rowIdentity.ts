const FNV_OFFSET_1 = 0x811c9dc5
const FNV_OFFSET_2 = 0x9e3779b9
const FNV_PRIME_1 = 0x01000193
const FNV_PRIME_2 = 0x85ebca77

function hashChunk(first: number, second: number, chunk: string): [number, number] {
  for (let index = 0; index < chunk.length; index += 1) {
    const code = chunk.charCodeAt(index)
    first = Math.imul(first ^ code, FNV_PRIME_1)
    second = Math.imul(second ^ code, FNV_PRIME_2)
  }
  return [first, second]
}

export function buildResultGridRowId(
  row: Record<string, unknown>,
  rowIndex: number,
  keyColumns: string[],
  includeRowIndexInId = keyColumns.length === 0,
): string {
  let first = FNV_OFFSET_1
  let second = FNV_OFFSET_2

  const add = (chunk: string) => {
    const next = hashChunk(first, second, chunk)
    first = next[0]
    second = next[1]
  }

  for (const column of keyColumns) {
    add(`column:${column.length}:`)
    add(column)

    const value = row[column]
    if (value === null) {
      add('value:null;')
      continue
    }
    if (value === undefined) {
      add('value:undefined;')
      continue
    }

    const text = String(value)
    add(`value:${typeof value}:${text.length}:`)
    add(text)
  }

  const hash = `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
  return includeRowIndexInId ? `row:${hash}:${rowIndex}` : `key:${hash}`
}
