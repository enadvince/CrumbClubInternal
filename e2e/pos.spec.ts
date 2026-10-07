import { expect, test, type Page } from "@playwright/test";

async function unlock(page: Page, pin = "1111") {
  await page.goto("/pos");
  await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible({ timeout: 20_000 });
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
  await expect(page.getByRole("tab", { name: /Individual Items/ })).toBeVisible();
}

async function sellOneUbeCash(page: Page) {
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  await page.getByRole("button", { name: /^Ube Croissant/ }).click();
  await page.getByRole("button", { name: /^Checkout/ }).click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(page.getByText("Sale saved")).toBeVisible();
}

test("sells offline, shows unsynced count, syncs when back online", async ({ page, context }) => {
  await unlock(page);
  await expect(page.getByRole("button", { name: /Online · all synced/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Ube Croissant.*24 left/ })).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await sellOneUbeCash(page);
  await sellOneUbeCash(page);

  await expect(page.getByRole("button", { name: /Offline · 2 unsynced/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ube Croissant.*22 left/ })).toBeVisible();

  // Survives a reload while offline (served from IndexedDB; page from the HTTP cache/dev server)
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("tab", { name: /Individual Items/ })).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole("button", { name: /Online · all synced/ })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  // Server now has both sales; stock is not double-counted.
  await expect(page.getByRole("button", { name: /^Ube Croissant.*22 left/ })).toBeVisible();
});

test("bundle: fixed bundle sells out when a component runs low; undo returns stock", async ({ page }) => {
  await unlock(page);
  await page.getByRole("tab", { name: /Bundles/ }).click();
  const box = page.getByRole("button", { name: /^Ube Box \(6\)/ });
  for (let i = 0; i < 4; i++) await box.click();
  // 24 ube → 4 boxes uses all of them
  await expect(box).toBeDisabled();
  await expect(box).toHaveAccessibleName(/All in cart/);
  await page.getByRole("button", { name: /^Checkout/ }).click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(box).toHaveAccessibleName(/Sold out/);

  // Undoing a sale needs an owner PIN: a staff PIN is refused.
  await page.getByRole("button", { name: /^Undo/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Owner PIN to void" })).toBeVisible();
  for (const d of "1111") await dialog.getByRole("button", { name: d, exact: true }).click();
  await expect(dialog.getByText(/isn't an owner PIN/)).toBeVisible();
  await expect(box).toHaveAccessibleName(/Sold out/);
  for (const d of "1234") await dialog.getByRole("button", { name: d, exact: true }).click();
  await expect(box).toBeEnabled();
});

test("filters: subcategories for individual items, type for bundles", async ({ page }) => {
  await unlock(page);
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  const filters = page.getByRole("radiogroup", { name: "Subcategory" });
  await filters.getByRole("radio", { name: "Sweets" }).click();
  await expect(page.getByRole("button", { name: /^Calamansi Tart/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ube Croissant/ })).toHaveCount(0);
  await filters.getByRole("radio", { name: "All" }).click();
  await expect(page.getByRole("button", { name: /^Ube Croissant/ })).toBeVisible();

  await page.getByRole("tab", { name: /Bundles/ }).click();
  await page.getByRole("radiogroup", { name: "Bundle type" }).getByRole("radio", { name: "Mix & match" }).click();
  await expect(page.getByRole("button", { name: /^Pick 3 Treats/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ube Box \(6\)/ })).toHaveCount(0);
});

test("owner-defined discount option applies in one tap", async ({ page }) => {
  await unlock(page);
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  await page.getByRole("button", { name: /^Ube Croissant/ }).click();
  await page.getByRole("button", { name: /Add discount/ }).click();
  await page.getByRole("button", { name: /^Senior citizen/ }).click();
  await expect(page.getByText(/Senior citizen/).first()).toBeVisible();
  await expect(page.getByText("−₱24.00").first()).toBeVisible();
});

test("mix-and-match picker requires the exact count", async ({ page }) => {
  await unlock(page);
  await page.getByRole("tab", { name: /Bundles/ }).click();
  await page.getByRole("button", { name: /^Pick 3 Treats/ }).click();
  const add = page.getByRole("button", { name: /Pick \d more|Add to cart/ });
  await expect(add).toBeDisabled();
  await page.getByRole("button", { name: /^Add Calamansi Tart/ }).click();
  await page.getByRole("button", { name: /^Add Calamansi Tart/ }).click();
  await page.getByRole("button", { name: /^Add Ensaymada/ }).click();
  await expect(page.getByRole("button", { name: /Add to cart · ₱210/ })).toBeEnabled();
  await page.getByRole("button", { name: /Add to cart/ }).click();
  await expect(page.getByLabel("Cart").getByText("2× Calamansi Tart")).toBeVisible();
});

test("QR Ph needs a reference and confirmation", async ({ page }) => {
  await unlock(page);
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  await page.getByRole("button", { name: /^Ensaymada/ }).click();
  await page.getByRole("button", { name: /^Checkout/ }).click();
  await page.getByRole("radio", { name: /QR Ph/ }).click();
  const complete = page.getByRole("button", { name: /^Complete sale/ });
  await expect(complete).toBeDisabled();
  await page.getByPlaceholder(/5012345678901/).fill("7001234567890");
  await page.getByRole("checkbox").check();
  await complete.click();
  await expect(page.getByText("Sale saved")).toBeVisible();
});

test("cold start with no network: the POS opens from the service worker cache", async ({ page, context }) => {
  await unlock(page);
  // Wait for the service worker to take control and cache the page and its chunks.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", () => r(null), { once: true }));
    }
  });
  await page.reload(); // load once under SW control so chunks go through it
  await expect(page.getByRole("tab", { name: /Individual Items/ })).toBeVisible({ timeout: 20_000 });

  await context.setOffline(true);
  const fresh = await context.newPage();
  await fresh.goto("/pos");
  await expect(fresh.getByRole("tab", { name: /Individual Items/ })).toBeVisible({ timeout: 20_000 });
  await fresh.getByRole("tab", { name: /Individual Items/ }).click();
  await fresh.getByRole("button", { name: /^Butter Croissant/ }).click();
  await fresh.getByRole("button", { name: /^Checkout/ }).click();
  await fresh.getByRole("button", { name: "Exact" }).click();
  await fresh.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(fresh.getByText("Sale saved")).toBeVisible();
  await expect(fresh.getByRole("button", { name: /Offline · 1 unsynced/ })).toBeVisible();
});

test("PWA manifest is served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.start_url).toBe("/pos");
  expect(json.icons.length).toBeGreaterThan(1);
});
