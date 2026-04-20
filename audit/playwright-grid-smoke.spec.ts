import { test, expect } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001";

test("research grid sweep smoke", async ({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });

  const responseErrors: Array<{ url: string; status: number }> = [];
  page.on("response", (response) => {
    if (response.status() >= 400) {
      responseErrors.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto(`${BASE_URL}/research`, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: /grid sweep/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /run sweep \(\d+ configs\)/i })).toBeVisible();

  const gridResponsePromise = page.waitForResponse((response) =>
    response.url().includes("/api/research/grid") && response.request().method() === "POST"
  );

  await page.getByRole("button", { name: /run sweep \(\d+ configs\)/i }).click();

  const gridResponse = await gridResponsePromise;
  expect(gridResponse.ok()).toBeTruthy();

  await expect(page.getByText(/tested \d+ \/ \d+ configs on \d+ entries matching filters/i)).toBeVisible({
    timeout: 30000,
  });

  const rows = page.locator("table tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 30000 });
  expect(await rows.count()).toBeGreaterThan(0);

  expect(responseErrors).toEqual([]);
});
