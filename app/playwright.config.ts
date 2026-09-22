import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5198', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-small', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', viewport: { width: 320, height: 568 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5198/api/health',
    reuseExistingServer: false,
    env: { WEB_PORT: '5198', API_PORT: '3198', APP_ORIGINS: 'http://127.0.0.1:5198', DATA_DIR: mkdtempSync(join(tmpdir(), 'qwen-e2e-')) },
  },
})