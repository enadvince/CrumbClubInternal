import { expect, test, type Page } from "@playwright/test";

async function unlock(page: Page, pin = "1111") {
  await page.goto("/pos");
  await expect(page.getByRole("heading", { name: "Enter your PIN" })).toBeVisible({ timeout: 20_000 });
  for (const d of pin) await page.getByRole("button", { name: d, exact: true }).click();
  await openShiftIfAsked(page);
  await expect(page.getByRole("tab", { name: /Individual Items/ })).toBeVisible();
}

/** A shift must be open before the first sale on a tablet. */
async function openShiftIfAsked(page: Page) {
  const open = page.getByRole("heading", { name: "Open shift" });
  const tabs = page.getByRole("tab", { name: /Individual Items/ });
  await expect(open.or(tabs)).toBeVisible({ timeout: 20_000 });
  if (await open.isVisible()) {
    await page.getByLabel("Opening float").fill("1000");
    await page.getByRole("button", { name: /Open shift and start selling/ }).click();
  }
}

async function sellOneUbeCash(page: Page) {
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  await page.getByRole("button", { name: /^Ube Croissant/ }).click();
  await page.getByRole("button", { name: /^Checkout/ }).click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(page.getByText("Sale saved")).toBeVisible();
  await expect(page.getByTestId("order-number")).toContainText(/#\d{3}\s*T1-\d{6}-\d{4}/);
  await expect(page.getByText("Sale saved")).toBeHidden({ timeout: 5_000 });
}

test("sells offline, shows unsynced count, syncs when back online", async ({ page, context }) => {
  await unlock(page);
  await expect(page.getByRole("button", { name: /Sync status: All synced/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Ube Croissant.*24 left/ })).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await sellOneUbeCash(page);
  await sellOneUbeCash(page);

  await expect(page.getByRole("button", { name: /Offline: orders saved on this device/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Ube Croissant.*22 left/ })).toBeVisible();
  // The sync panel lists both orders with their numbers.
  await page.getByTestId("sync-pill").click();
  await expect(page.getByTestId("sync-item")).toHaveCount(2);
  await expect(page.getByTestId("sync-item").first()).toContainText(/T1-\d{6}-0001/);
  await page.keyboard.press("Escape");

  // Survives a reload while offline (served from IndexedDB; page from the HTTP cache/dev server)
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("tab", { name: /Individual Items/ })).toBeVisible({ timeout: 20_000 });

  await expect(page.getByRole("button", { name: /Sync status: All synced/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("sync-pill")).toHaveAttribute("data-tone", "ok");
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  // Server now has both sales; stock is not double-counted.
  await expect(page.getByRole("button", { name: /^Ube Croissant.*22 left/ })).toBeVisible();
});

test("bundle: out of stock warns but never blocks; undo returns stock", async ({ page }) => {
  await unlock(page);
  await page.getByRole("tab", { name: /Bundles/ }).click();
  const box = page.getByRole("button", { name: /^Ube Box \(6\)/ });
  for (let i = 0; i < 4; i++) await box.click();
  // 24 ube: 4 boxes use all of them. The tile shows Out of stock but stays usable.
  await expect(box).toHaveAccessibleName(/Out of stock/);
  await expect(box).toBeEnabled();
  await box.click();
  const confirm = page.getByRole("dialog", { name: "Out of stock on record" });
  await expect(confirm.getByText("Out of stock on record. Add anyway?")).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel("Cart").getByLabel("Quantity 4")).toBeVisible();
  await page.getByRole("button", { name: /^Checkout/ }).click();
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByRole("button", { name: /^Complete sale/ }).click();
  await expect(box).toHaveAccessibleName(/Out of stock/);

  // Undoing a sale needs an owner PIN: a staff PIN is refused.
  await page.getByRole("button", { name: /^Undo/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Owner PIN to void" })).toBeVisible();
  for (const d of "1111") await dialog.getByRole("button", { name: d, exact: true }).click();
  await expect(dialog.getByText(/isn't an owner PIN/)).toBeVisible();
  await expect(box).toHaveAccessibleName(/Out of stock/);
  for (const d of "1234") await dialog.getByRole("button", { name: d, exact: true }).click();
  await expect(box).not.toHaveAccessibleName(/Out of stock/);
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
  await expect(fresh.getByRole("button", { name: /Offline: orders saved on this device/ })).toBeVisible();
});

test("PWA manifest is served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.start_url).toBe("/pos");
  expect(json.icons.length).toBeGreaterThan(1);
});

async function enterPin(scope: ReturnType<Page["getByRole"]>, pin: string) {
  for (const d of pin) await scope.getByRole("button", { name: d, exact: true }).click();
}

test("void and refund from the order history need an owner PIN and keep the order number", async ({ page }) => {
  await unlock(page);
  await sellOneUbeCash(page);
  await sellOneUbeCash(page);
  await page.getByRole("button", { name: /Orders/ }).click();
  const orders = page.getByRole("dialog", { name: "Orders" });
  await expect(orders.getByTestId("order-row")).toHaveCount(2);
  // Search by the short number staff call out.
  await orders.getByRole("searchbox").fill("002");
  await expect(orders.getByTestId("order-row")).toHaveCount(1);
  await orders.getByRole("button", { name: "Void order" }).click();
  const voidDialog = page.getByRole("dialog", { name: /Void order/ });
  await voidDialog.getByRole("radio", { name: "Wrong item" }).click();
  await voidDialog.getByRole("button", { name: /owner PIN/ }).click();
  await enterPin(voidDialog, "1234");
  await expect(orders.getByTestId("order-row").first()).toContainText("Voided");
  await expect(orders.getByTestId("order-row").first()).toContainText(/T1-\d{6}-0002/);

  await orders.getByRole("searchbox").fill("001");
  await orders.getByRole("button", { name: "Refund" }).click();
  const refund = page.getByRole("dialog", { name: /Refund/ });
  await refund.getByRole("button", { name: /One more Ube Croissant/ }).click();
  await refund.getByRole("radio", { name: "Customer changed mind" }).click();
  await expect(refund.getByText("₱120.00")).toBeVisible();
  await refund.getByRole("button", { name: /owner PIN/ }).click();
  await enterPin(refund, "1234");
  await expect(orders.getByTestId("order-row").first()).toContainText("Refunded ₱120.00");
  await orders.getByRole("button", { name: "Close" }).click();
  // Both croissants are back in stock.
  await page.getByRole("tab", { name: /Individual Items/ }).click();
  await expect(page.getByRole("button", { name: /^Ube Croissant.*24 left/ })).toBeVisible();
});

test("five wrong owner PINs lock owner PIN entry for 5 minutes", async ({ page }) => {
  await unlock(page);
  await page.getByRole("button", { name: /⚙ Owner/ }).click();
  const gate = page.getByRole("dialog", { name: "Owner PIN" });
  for (let i = 0; i < 5; i++) await enterPin(gate, "9999");
  await expect(gate.getByText(/Too many wrong owner PINs. Try again in [45]:\d\d/)).toBeVisible();
  await expect(gate.getByRole("button", { name: "1", exact: true })).toBeDisabled();
});

test("close a shift offline with a ₱100 variance: owner PIN and note, provisional then final", async ({ page, context }) => {
  await unlock(page); // opens the shift with a ₱1,000 float
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await sellOneUbeCash(page); // ₱120 cash
  await page.getByRole("button", { name: /💵 Shift/ }).click();
  const panel = page.getByRole("dialog", { name: "Shift" });
  await panel.getByRole("button", { name: "Close shift" }).click();
  // Blind count: the expected amount is not shown before counting.
  await expect(panel.getByText("₱1,120.00")).toHaveCount(0);
  await panel.getByRole("radio", { name: "Enter total" }).click();
  await panel.getByLabel("Counted cash").fill("1020"); // expected 1,120: ₱100 short
  await panel.getByRole("button", { name: "Show expected" }).click();
  await expect(panel.getByText("₱1,120.00")).toBeVisible();
  await expect(panel.getByText(/more than ₱50.00/)).toBeVisible();
  await panel.getByLabel("Note (required)").fill("gave wrong change");
  await panel.getByRole("button", { name: /owner PIN/ }).click();
  for (const d of "1234") await panel.getByRole("button", { name: d, exact: true }).click();
  await page.getByRole("dialog", { name: "Close shift?" }).getByRole("button", { name: "Close shift" }).click();
  await expect(page.getByRole("heading", { name: "Shift report" })).toBeVisible();
  await expect(page.getByTestId("report-status")).toHaveText(/Provisional: 1 order not yet synced/);
  await expect(page.getByText("−₱100.00").first()).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("report-status")).toHaveText(/Final/, { timeout: 30_000 });
});

test("emergency export downloads unsynced orders", async ({ page, context }) => {
  await unlock(page);
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await sellOneUbeCash(page);
  await page.getByRole("button", { name: /⚙ Owner/ }).click();
  for (const d of "1234") await page.getByRole("dialog", { name: "Owner PIN" }).getByRole("button", { name: d, exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Owner menu" });
  await expect(menu.getByText("Emergency export (last resort)")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), menu.getByRole("button", { name: /Emergency export \(JSON\)/ }).click()]);
  const text = await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString("utf8"));
  const data = JSON.parse(text) as { kind: string; unsynced: { type: string; display?: { orderNumber?: string } }[] };
  expect(data.kind).toBe("crumbclub-pos-emergency-export");
  expect(data.unsynced.some((o) => o.type === "sale" && /T1-\d{6}-\d{4}/.test(o.display?.orderNumber ?? ""))).toBe(true);
});
