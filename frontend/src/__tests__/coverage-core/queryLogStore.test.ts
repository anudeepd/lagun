import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQueryLogStore, type QueryLogEntry } from '../../store/queryLogStore'

const entry = (sql: string): Omit<QueryLogEntry, 'id' | 'timestamp'> => ({
  sql,
  sessionId: 'session-1',
  execTimeMs: 1,
})

function reset() {
  localStorage.clear()
  useQueryLogStore.setState({ entries: [] })
}

beforeEach(reset)

describe('query log store', () => {
  it('prepends entries with generated identity and timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-27T10:00:00.000Z'))

    useQueryLogStore.getState().addEntry(entry('SELECT 1'))
    useQueryLogStore.getState().addEntry(entry('SELECT 2'))

    const entries = useQueryLogStore.getState().entries
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      sql: 'SELECT 2',
      timestamp: '2026-11-27T10:00:00.000Z',
    })
    expect(entries[0].id).not.toBe(entries[1].id)
    vi.useRealTimers()
  })

  it('caps the live log at one hundred entries', () => {
    for (let index = 0; index < 105; index += 1) {
      useQueryLogStore.getState().addEntry(entry(`SELECT ${index}`))
    }

    const entries = useQueryLogStore.getState().entries
    expect(entries).toHaveLength(100)
    expect(entries[0].sql).toBe('SELECT 104')
    expect(entries.at(-1)?.sql).toBe('SELECT 5')
  })

  it('clears all entries', () => {
    useQueryLogStore.getState().addEntry(entry('SELECT 1'))

    useQueryLogStore.getState().clearLog()

    expect(useQueryLogStore.getState().entries).toEqual([])
  })
})

describe('query log persistence', () => {
  it('trims version-two persisted logs during migration', () => {
    const migrate = useQueryLogStore.persist.getOptions().migrate
    const persisted = {
      entries: Array.from({ length: 60 }, (_, index) => ({ sql: `SELECT ${index}` })),
    }

    const migrated = migrate?.(persisted, 2) as typeof persisted

    expect(migrated.entries).toHaveLength(50)
    expect(migrated.entries[0].sql).toBe('SELECT 0')
  })

  it('accepts old persisted data that has no entry list', () => {
    const migrate = useQueryLogStore.persist.getOptions().migrate
    const persisted = { activeSessionId: 'session-1' }

    expect(migrate?.(persisted, 1)).toBe(persisted)
  })

  it('leaves current or newer persisted logs alone', () => {
    const migrate = useQueryLogStore.persist.getOptions().migrate
    const persisted = {
      entries: Array.from({ length: 60 }, (_, index) => ({ sql: `SELECT ${index}` })),
    }

    const migrated = migrate?.(persisted, 3) as typeof persisted

    expect(migrated.entries).toHaveLength(60)
  })

  it('persists only the newest fifty entries and strips bulky SQL text', () => {
    const partialize = useQueryLogStore.persist.getOptions().partialize
    const entries = Array.from({ length: 60 }, (_, index) => ({
      id: String(index),
      timestamp: '2024-01-01T00:00:00.000Z',
      sql: 'CALL bulk()',
      sessionId: 'session-1',
      execTimeMs: 1,
      bulk: {
        statementCount: 2,
        operationCounts: { INSERT: 2 },
        rolledBack: false,
        fullSql: `INSERT ${index}; INSERT ${index};`,
      },
    }))
    const plain = {
      id: 'plain',
      timestamp: '2024-01-01T00:00:00.000Z',
      sql: 'SELECT 1',
      sessionId: 'session-1',
      execTimeMs: 1,
    }
    useQueryLogStore.setState({ entries: [plain, ...entries] })

    const persisted = partialize?.(useQueryLogStore.getState()) as { entries: QueryLogEntry[] }

    expect(persisted.entries).toHaveLength(50)
    expect(persisted.entries[0]).toEqual(plain)
    expect(persisted.entries[1].bulk?.fullSql).toBeUndefined()
    expect(persisted.entries[1].bulk?.statementCount).toBe(2)
  })
})
