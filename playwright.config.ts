import { existsSync } from "node:fs"
import { chromium, defineConfig } from "@playwright/test"

export const STORAGE_STATE = "test-results/.auth/state.json"

/** E2E_CHROME があればそのブラウザ、無ければ Playwright の chromium（`bunx playwright install chromium` で入る） */
function browserPath() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME
  if (existsSync(chromium.executablePath())) return undefined
  throw new Error("Playwright の chromium がありません。`bunx playwright install chromium` で入れるか、E2E_CHROME に Chrome の実行ファイルのパスを入れてください")
}

export default defineConfig({
  testDir: "e2e",
  timeout: 300_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:3211",
    viewport: { width: 1500, height: 1000 },
    launchOptions: { executablePath: browserPath() },
  },
  projects: [
    { name: "login", testMatch: /login\.setup\.ts/ },
    { name: "app", dependencies: ["login"], use: { storageState: STORAGE_STATE } },
  ],
  webServer: { command: "bun run dev", url: "http://localhost:3211/login", reuseExistingServer: true, timeout: 120_000 },
})
