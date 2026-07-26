import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImportDialog from '../../components/table/ImportDialog'

const props = {
  open: true,
  onClose: () => {},
  sessionId: 'session-1',
  database: 'lagun_test',
}

describe('ImportDialog formats', () => {
  it('offers CSV and MySQL dump formats', () => {
    render(<ImportDialog {...props} />)
    expect(screen.getByLabelText('File Format')).toBeInTheDocument()
    expect(screen.getByText('CSV Format Options')).toBeInTheDocument()
  })

  it('layers the target-table menu above the import dialog', async () => {
    render(<ImportDialog {...props} />)
    await userEvent.click(screen.getByLabelText('Target Table'))
    expect(screen.getByRole('listbox', { name: 'Target Table' })).toHaveClass('z-critical')
  })

  it('allows dump imports without a target table and warns about SQL execution', async () => {
    render(<ImportDialog {...props} />)
    await userEvent.click(screen.getByLabelText('File Format'))
    await userEvent.click(screen.getByRole('option', { name: 'MySQL dump (.sql / .dump)' }))
    expect(screen.queryByLabelText('Target Table')).not.toBeInTheDocument()
    expect(screen.queryByText(/execute SQL from the file/i)).toBeInTheDocument()
  })

  it('shows unrestricted dump scope despite a preselected table', async () => {
    render(<ImportDialog {...props} table="users" />)
    await userEvent.click(screen.getByLabelText('File Format'))
    await userEvent.click(screen.getByRole('option', { name: 'MySQL dump (.sql / .dump)' }))
    expect(screen.getByText('Import MySQL dump into lagun_test')).toBeInTheDocument()
    expect(screen.queryByText('Import into lagun_test.users')).not.toBeInTheDocument()
  })

  it('uses a bounded file slice only when preview is requested', async () => {
    let uploadedBytes = 0
    render(<ImportDialog {...props} table="users" />)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const form = init?.body as FormData
      uploadedBytes = (form.get('file') as File).size
      return new Response(JSON.stringify({
        format: 'csv',
        columns: ['name'],
        rows: [['Alice']],
        total_lines_sampled: 1,
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File([new Uint8Array(2 * 1024 * 1024)], 'large.csv', { type: 'text/csv' })
    await userEvent.upload(input!, file)

    expect(screen.getByRole('button', { name: /selected file large.csv/i })).toBeInTheDocument()
    expect(uploadedBytes).toBe(0)
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Alice')
    expect(uploadedBytes).toBe(1024 * 1024)
    fetchSpy.mockRestore()
  })
})
