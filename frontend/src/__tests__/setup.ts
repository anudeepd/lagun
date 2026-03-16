import { beforeAll, afterEach, afterAll } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { server } from './server'

// Vitest 2.x has a bug where it installs a broken localStorage stub in jsdom.
// Provide a proper in-memory implementation so Zustand's persist middleware works.
const _localStorageStore: Record<string, string> = {}
const localStorageMock: Storage = {
  getItem: (key) => _localStorageStore[key] ?? null,
  setItem: (key, value) => { _localStorageStore[key] = String(value) },
  removeItem: (key) => { delete _localStorageStore[key] },
  clear: () => { Object.keys(_localStorageStore).forEach(k => delete _localStorageStore[k]) },
  get length() { return Object.keys(_localStorageStore).length },
  key: (index) => Object.keys(_localStorageStore)[index] ?? null,
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true })

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
