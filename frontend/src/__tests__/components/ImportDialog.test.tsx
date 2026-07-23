import { describe, it, expect } from 'vitest'
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
})

  it('shows unrestricted dump scope despite a preselected table', async () => {
    render(<ImportDialog {...props} table="users" />)
    await userEvent.click(screen.getByLabelText('File Format'))
    await userEvent.click(screen.getByRole('option', { name: 'MySQL dump (.sql / .dump)' }))
    expect(screen.getByText('Import MySQL dump into lagun_test')).toBeInTheDocument()
    expect(screen.queryByText('Import into lagun_test.users')).not.toBeInTheDocument()
  })
