import { create } from 'zustand'
import { api } from '../api/client'

interface ServerConfigState {
  ldapEnabled: boolean
  isAdmin: boolean
  ldapIdleTimeout: number
  queryMaxResultRows: number
  load: () => Promise<void>
}

export const useServerConfigStore = create<ServerConfigState>((set) => ({
  ldapEnabled: false,
  isAdmin: false,
  ldapIdleTimeout: 0,
  queryMaxResultRows: 1_000_000,
  load: async () => {
    try {
      const config = await api.getServerConfig()
      set({
        ldapEnabled: config.ldap_enabled,
        isAdmin: config.is_admin,
        ldapIdleTimeout: config.ldap_idle_timeout,
        queryMaxResultRows: config.query_max_result_rows ?? 1_000_000,
      })
    } catch {
      // silently ignore — ldap stays false
    }
  },
}))
