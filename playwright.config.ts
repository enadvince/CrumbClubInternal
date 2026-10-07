import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run the POS in demo mode (NEXT_PUBLIC_POS_DEMO=1): a fake in-browser
 * server instead of Supabase, so offline/online behaviour can be tested anywhere.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3200",
    viewport: { width: 1280, height: 800 },
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, hasTouch: true } }],
  webServer: {
    command: "NEXT_PUBLIC_POS_DEMO=1 npx next build && NEXT_PUBLIC_POS_DEMO=1 PORT=3200 npx next start",
    url: "http://localhost:3200/login",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
  },
});
