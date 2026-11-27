import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import Tooltip from '../../components/ui/Tooltip'

describe('Tooltip server rendering', () => {
  it('omits the portal when no document exists', () => {
    vi.stubGlobal('document', undefined)
    try {
      const html = renderToString(
        <Tooltip label="Server tip">
          <button type="button">Server control</button>
        </Tooltip>,
      )

      expect(html).toContain('Server control')
      expect(html).not.toContain('Server tip')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
