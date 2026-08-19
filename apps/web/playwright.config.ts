import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.EGRESS_E2E_BASE_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: "line",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { browserName: "chromium", viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chromium",
      use: { browserName: "chromium", viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: externalBaseUrl ? undefined : {
    command: "npm run start -- --port 3100",
    env: {
      EGRESS_RUNTIME_MODE: "LIVE_READ_ONLY",
      EGRESS_DEPLOYMENT_ENV: "",
      EGRESS_XLAYER_RPC_URL: "",
      EGRESS_LIVE_ACCOUNT: "",
      EGRESS_LIVE_EGRESS_SPENDER: "",
      EGRESS_DATABASE_URL: "",
      EGRESS_RISK_STORE_PATH: "",
      EGRESS_LIVE_ARCHIVE_PATH: "",
    },
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
