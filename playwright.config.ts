import { defineConfig, devices } from '@playwright/test';

// Playwright targets the dockerized dev server. Bring it up with
// `docker compose up -d --build` before running. Override the URL via
// PLAYWRIGHT_BASE_URL for non-default hosts/ports.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:6060',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
