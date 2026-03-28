import { create } from 'zustand'
import { api } from '../api/client'

interface ServerConfigState {
  ldapEnabled: boolean
  load: () => Promise<void>
}

export const useServerConfigStore = create<ServerConfigState>((set) => ({
  ldapEnabled: false,
  load: async () => {
    try {
      const config = await api.getServerConfig()
      set({ ldapEnabled: config.ldap_enabled })
    } catch {
      // silently ignore — ldap stays false
    }
  },
}))
