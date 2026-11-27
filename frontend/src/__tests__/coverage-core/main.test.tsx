import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  createRoot: vi.fn(),
  installScrollbarFallback: vi.fn(),
  installFocusModality: vi.fn(() => vi.fn()),
}))

vi.mock('react-dom/client', () => ({
  default: { createRoot: mocks.createRoot },
  createRoot: mocks.createRoot,
}))
vi.mock('../../App', () => ({ default: () => null }))
vi.mock('../../utils/scrollbarFallback', () => ({
  installScrollbarFallback: mocks.installScrollbarFallback,
}))
vi.mock('../../utils/focusModality', () => ({
  installFocusModality: mocks.installFocusModality,
}))

describe('application bootstrap', () => {
  it('installs browser fallbacks before mounting the React tree', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    mocks.createRoot.mockReturnValue({ render: mocks.render })

    await import('../../main')

    expect(mocks.installScrollbarFallback).toHaveBeenCalledOnce()
    expect(mocks.installFocusModality).toHaveBeenCalledOnce()
    expect(mocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'))
    expect(mocks.render).toHaveBeenCalledOnce()
  })
})
