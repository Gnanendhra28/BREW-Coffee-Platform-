import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for BREW Mobile Coffee Platform.
 * Configured to support both local developer runs and CI execution.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
    webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: 'node .next/standalone/server.js',
        url: 'http://localhost:3000',
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});
