import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useSchemaStore } from '../../store/schemaStore'
import SchemaTree from '../../components/schema/SchemaTree'

// The gate under test only decides *whether* the lazily loaded dialog is
// mounted at all (that is what keeps its chunk out of the initial render), so
// stub it with a marker that mirrors `open` and exposes a close button.
vi.mock('../../components/table/CreateTableDialog', () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <div data-testid="create-table-dialog" data-open={String(open)}>
      <button onClick={onClose}>close stub</button>
    </div>
  ),
}))

const SESSION = 'session-1'

describe('lazily loaded dialogs mount only after their first open', () => {
  beforeEach(() => {
    useSchemaStore.setState({
      databases: { [SESSION]: ['app_db'] },
      tables: {},
      columns: {},
      loadingDbs: new Set(),
      loadingTables: new Set(),
      dbErrors: {},
    })
  })

  it('keeps CreateTableDialog out of the tree until it is opened, then mounted after closing', async () => {
    render(<SchemaTree sessionId={SESSION} />)

    // An unconditionally mounted lazy dialog resolves its chunk and renders a
    // moment after the initial commit, so flush that before concluding it is
    // absent: the assertion then really means "not mounted", not "not yet".
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(screen.queryByTestId('create-table-dialog')).not.toBeInTheDocument()

    fireEvent.contextMenu(screen.getByTitle('app_db'))
    fireEvent.click(screen.getByRole('menuitem', { name: /Create Table/ }))

    // Mounted with the real `open` value, so the dialog opens normally.
    expect(await screen.findByTestId('create-table-dialog')).toHaveAttribute('data-open', 'true')

    // Closing keeps it mounted (open=false) so its exit animation still plays.
    fireEvent.click(screen.getByRole('button', { name: 'close stub' }))
    expect(screen.getByTestId('create-table-dialog')).toHaveAttribute('data-open', 'false')
  })
})
