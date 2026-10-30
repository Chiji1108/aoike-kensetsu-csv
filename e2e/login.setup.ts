import { test as setup } from "@playwright/test"
import { STORAGE_STATE } from "../playwright.config"
import { open } from "./helpers"

/** ログインの回数制限（1分に5回）に当たらないよう、ログインは1回にして各テストで使い回す */
setup("ログイン", async ({ page }) => {
  const password = process.env.E2E_PASSWORD
  if (!password) throw new Error("E2E_PASSWORD にローカルの事務所共通パスワードを入れてください（README の「ブラウザでの確認」）")
  await open(page, "/login")
  await page.locator('input[type="password"]').fill(password)
  await page.locator('button[type="submit"]').click()
  await page.waitForURL("/")
  await page.context().storageState({ path: STORAGE_STATE })
})
