import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { redirectToLdapLogin } = vi.hoisted(() => ({
  redirectToLdapLogin: vi.fn(),
}))

vi.mock('../../utils/authRedirect', () => ({
  redirectToLdapLogin,
}))

import { api, importFileWithProgress } from '../../api/client'

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []

  upload: {
    onprogress?: (event: ProgressEvent) => void
    onload?: () => void
  } = {}

  onabort?: () => void
  onerror?: () => void
  onload?: () => void
  status = 200
  statusText = 'OK'
  responseText = '{}'
  open = vi.fn()
  send = vi.fn()
  sentBody: Document | XMLHttpRequestBodyInit | null = null

  constructor() {
    FakeXMLHttpRequest.instances.push(this)
  }

  respond(options: {
    status?: number
    statusText?: string
    responseText?: string
  }) {
    Object.assign(this, options)
    this.onload?.()
  }
}

function installXhr() {
  FakeXMLHttpRequest.instances = []
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  return FakeXMLHttpRequest
}

beforeEach(() => {
  redirectToLdapLogin.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('XMLHttpRequest import progress', () => {
  it('reports computable upload bytes, the response phase, and parsed success', async () => {
    const Xhr = installXhr()
    const form = new FormData()
    form.append('file', new Blob(['rows']), 'rows.csv')
    const progress = vi.fn()

    const request = importFileWithProgress<{ imported: number }>(
      'session-1',
      form,
      progress,
    )
    const xhr = Xhr.instances[0]

    expect(xhr.open).toHaveBeenCalledWith(
      'POST',
      '/api/v1/sessions/session-1/import',
    )
    expect(xhr.send).toHaveBeenCalledWith(form)

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 10 } as ProgressEvent)
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 3, total: 0 } as ProgressEvent)
    xhr.upload.onload?.()
    xhr.respond({ status: 201, responseText: '{"imported":42}' })

    await expect(request).resolves.toEqual({ imported: 42 })
    expect(progress.mock.calls).toEqual([
      [{ loaded: 3, total: 10 }],
      [null],
    ])
  })

  it('works without a progress observer', async () => {
    const Xhr = installXhr()

    const request = importFileWithProgress('session-1', new FormData())
    const xhr = Xhr.instances[0]

    expect(() => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent)
      xhr.upload.onload?.()
    }).not.toThrow()
    xhr.respond({ responseText: '{"ok":true}' })

    await expect(request).resolves.toEqual({ ok: true })
  })

  it('routes a signed-out import to the login redirect', async () => {
    const Xhr = installXhr()

    const request = importFileWithProgress('session-1', new FormData())
    Xhr.instances[0].respond({ status: 401, statusText: 'Unauthorized' })

    await expect(request).rejects.toThrow(
      'Authentication required. Redirecting to login.',
    )
    expect(redirectToLdapLogin).toHaveBeenCalledOnce()
  })

  it('uses the same body-derived message for a rejected HTTP import', async () => {
    const Xhr = installXhr()

    const request = importFileWithProgress('session-1', new FormData())
    Xhr.instances[0].respond({
      status: 413,
      statusText: 'Payload Too Large',
      responseText: 'file exceeds the 25 MB limit',
    })

    await expect(request).rejects.toThrow('file exceeds the 25 MB limit')
  })

  it('rejects invalid JSON from a successful import', async () => {
    const Xhr = installXhr()

    const request = importFileWithProgress('session-1', new FormData())
    Xhr.instances[0].respond({ status: 200, responseText: 'not json' })

    await expect(request).rejects.toThrow(SyntaxError)
  })

  it('rejects aborted and network-failed uploads', async () => {
    const Xhr = installXhr()
    const aborted = importFileWithProgress('session-1', new FormData())
    Xhr.instances[0].onabort?.()
    await expect(aborted).rejects.toThrow('Import upload aborted')

    const failed = importFileWithProgress('session-1', new FormData())
    Xhr.instances[1].onerror?.()
    await expect(failed).rejects.toThrow('Import upload failed')
  })
})

describe('fetch import fallback', () => {
  it('reads a successful JSON import through fetch without XMLHttpRequest', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"imported":7}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const form = new FormData()

    await expect(api.importFile('session-1', form)).resolves.toEqual({ imported: 7 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/sessions/session-1/import',
      expect.objectContaining({ method: 'POST', body: form }),
    )
  })

  it('reads a fetch import failure with the shared error formatter', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('import rejected', {
        status: 422,
        statusText: 'Unprocessable Entity',
      })),
    )

    await expect(api.importFile('session-1', new FormData()))
      .rejects.toThrow('import rejected')
  })
})
