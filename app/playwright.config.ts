import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const webPort = process.env.E2E_WEB_PORT ?? '5198'
const apiPort = process.env.E2E_API_PORT ?? '3198'
const baseURL = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-small', use: { ...devices['iPhone SE'], defaultBrowserType: 'chromium', viewport: { width: 320, height: 568 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run predev && npx concurrently -k -n api,web "node --import tsx server/index.ts" "vite"',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: { WEB_PORT: webPort, API_PORT: apiPort, APP_ORIGINS: baseURL, DATA_DIR: mkdtempSync(join(tmpdir(), 'qwen-e2e-')) },
  },
})