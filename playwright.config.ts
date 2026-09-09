import { defineConfig } from '@playwright/test'
import { testEndpoint } from './tests/support/test-server'

const endpoint = testEndpoint()

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/support/playwright-global-setup.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: endpoint.baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `npm run web:preview -- --host 127.0.0.1 --port ${endpoint.port} --strictPort`,
    url: endpoint.baseURL,
    reuseExistingServer: false
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium'
      }
    }
  ]
})
