import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    // vitest 4 no longer copies jsdom's `AbortController`/`AbortSignal` over the
    // Node globals, so `fetch(..., { signal })` works under jsdom as it does in a
    // browser (vitest-dev/vitest#8390). The environment wrapper this repo needed
    // on vitest 3 is gone with it.
    environment: 'jsdom',
    setupFiles: './src/__tests__/setup.ts',
    pool: 'forks',
    // `poolOptions` was removed in vitest 4: pool options are top-level now.
    execArgv: ['--no-warnings'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
  },
})
