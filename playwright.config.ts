import { defineConfig, devices } from '@playwright/test';

const chromium = { executablePath: process.env.BRON_CHROMIUM_PATH };

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 45_000,
  reporter: 'list',
  use: {
    timezoneId: 'Europe/Moscow',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-chromium',
      testIgnore: '**/pwa.spec.ts',
      use: { ...devices['Pixel 7'], launchOptions: chromium },
    },
    {
      name: 'mobile-webkit',
      testIgnore: '**/pwa.spec.ts',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'pwa-chromium',
      testMatch: '**/pwa.spec.ts',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, launchOptions: chromium },
    },
  ],
});
