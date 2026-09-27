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
})
