import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://127.0.0.1:1421', channel: 'msedge', headless: true, viewport: { width: 1200, height: 1000 } },
  webServer: { command: 'pnpm dev --host 127.0.0.1 --port 1421', url: 'http://127.0.0.1:1421', reuseExistingServer: !process.env.CI },
});
