import { beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../server'
import { useServerConfigStore } from '../../store/serverConfigStore'

const BASE = 'http://localhost/api/v1'

function reset() {
  useServerConfigStore.setState({
    ldapEnabled: false,
    isAdmin: false,
    ldapIdleTimeout: 0,
    queryMaxResultRows: 1_000_000,
  })
}

beforeEach(reset)

describe('server config store', () => {
  it('loads LDAP, admin, and row-limit policy from the server', async () => {
    server.use(
      http.get(`${BASE}/config/server`, () => HttpResponse.json({
        ldap_enabled: true,
        ldap_idle_timeout: 900,
        is_admin: true,
        query_max_result_rows: 250_000,
      })),
    )

    await useServerConfigStore.getState().load()

    expect(useServerConfigStore.getState()).toMatchObject({
      ldapEnabled: true,
      isAdmin: true,
      ldapIdleTimeout: 900,
      queryMaxResultRows: 250_000,
    })
  })

  it('accepts an explicit zero row cap without replacing it', async () => {
    server.use(
      http.get(`${BASE}/config/server`, () => HttpResponse.json({
        ldap_enabled: false,
        ldap_idle_timeout: 0,
        is_admin: false,
        query_max_result_rows: 0,
      })),
    )

    await useServerConfigStore.getState().load()

    expect(useServerConfigStore.getState().queryMaxResultRows).toBe(0)
  })

  it('uses the built-in row limit when the server omits one', async () => {
    server.use(
      http.get(`${BASE}/config/server`, () => HttpResponse.json({
        ldap_enabled: false,
        ldap_idle_timeout: 0,
        is_admin: false,
      })),
    )

    await useServerConfigStore.getState().load()

    expect(useServerConfigStore.getState().queryMaxResultRows).toBe(1_000_000)
  })

  it('keeps the previous policy when the config request fails', async () => {
    useServerConfigStore.setState({
      ldapEnabled: true,
      isAdmin: true,
      ldapIdleTimeout: 120,
      queryMaxResultRows: 42,
    })
    server.use(
      http.get(`${BASE}/config/server`, () =>
        HttpResponse.json({ detail: 'offline' }, { status: 503 })
      ),
    )

    await useServerConfigStore.getState().load()

    expect(useServerConfigStore.getState()).toMatchObject({
      ldapEnabled: true,
      isAdmin: true,
      ldapIdleTimeout: 120,
      queryMaxResultRows: 42,
    })
  })
})
