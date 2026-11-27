import { defineConfig, devices } from '@playwright/test'
import { tmpdir } from 'node:os'
import path from 'node:path'

import baseConfig from './playwright.config'

export default defineConfig({
  ...baseConfig,
  outputDir: path.join(tmpdir(), 'lagun-playwright-results'),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
