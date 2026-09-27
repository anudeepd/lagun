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
    // `environment.ts` wraps vitest's jsdom environment to keep Node's
    // `AbortController`/`AbortSignal`; jsdom's pair breaks `fetch(..., { signal })`
    // on Node 24. See the comment there.
    environment: './src/__tests__/environment.ts',
    setupFiles: './src/__tests__/setup.ts',
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--no-warnings'],
      },
    },
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
  },
})
