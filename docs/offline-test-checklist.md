# Offline manual test checklist

Run this on the real counter tablet (Huawei, landscape) before relying on a new version, and after any change to the service worker, sync or shifts. Most steps are also covered by automated tests (noted in brackets); the tablet run catches what only real hardware and Huawei Browser can show.

**Before you start**
- Install the app from the browser menu (Add to home screen / Install app) and open it from the home screen icon.
- Sign in with a staff PIN, open a shift, and wait for the green **All synced** pill.
- To go offline: turn off Wi-Fi and mobile data in the tablet's quick settings (Airplane mode). Don't use only the browser's settings.

| # | Step | Expected | Pass |
|---|---|---|---|
| 1 | Load the POS, turn the network off, then fully close and reopen the app (or pull to refresh / hard refresh). | The POS opens and you can sell. No "You're offline" page. *(e2e: cold start)* | ☐ |
| 2 | Offline, ring up 3 orders. | Each shows "Sale saved" with its number (#001, #002, #003). The pill shows grey **Offline: orders saved on this device**. The sync panel lists 3 orders. When online but not yet sent, the pill reads amber **3 orders pending sync**. *(e2e, unit)* | ☐ |
| 3 | Turn the network back on. | A toast says **Back online, syncing 3 orders**. The pill turns blue **Syncing 3 orders...**, then green **All synced**. The 3 orders appear under Transactions on the owner pages with the same numbers. *(integration)* | ☐ |
| 4 | Ring up an order online, and close the app from the app switcher right after tapping Complete sale. Reopen. | The order is still there and syncs. Owner pages show it once, never twice. Order count matches what was sold. *(unit: interrupted send; integration: forced resync)* | ☐ |
| 5 | Change the tablet's date/time (Settings, turn off automatic time, set it 3 hours off). Ring up an order online. Restore automatic time. | The order's server time on the owner pages is correct. The sync panel warns the clock is off. Transactions export shows both times. *(SQL: drift)* | ☐ |
| 6 | Deploy a new version while the tablet has pending orders (stay offline, ring up an order, then reconnect only after the deploy finishes). | **Update available** appears. Tapping **Update now** with orders pending says **Finish syncing orders before updating.** Once **All synced** and the cart is empty, Update now reloads into the new version. The page never reloads on its own. | ☐ |
| 7 | Open the owner menu and enter a wrong owner PIN 5 times. | Entry locks: "Too many wrong owner PINs. Try again in 5:00", counting down. Keys are disabled. Reloading the app keeps the lock. After 5 minutes the right PIN works. *(e2e, unit)* | ☐ |
| 8 | Offline, ring up an order, then close the shift (count the drawer, then confirm). | The report says **Provisional: 1 order not yet synced**. Reconnect: it changes to **Final: everything synced** without doing anything. *(e2e, integration)* | ☐ |
| 9 | Close a shift with a ₱100 difference (count ₱100 less than expected). | The expected amount appears only after the count. A red note says the variance is more than ₱50; a note and an owner PIN are required before closing. The audit log shows the approval. *(e2e, unit, SQL)* | ☐ |
| 10 | On the owner pages, set a product's low stock alert above its current stock. Sync the tablet. Ring up the last of a product. | The tile shows amber **Low: N left**, then red **Out of stock** at zero. Tapping an out-of-stock tile asks **Out of stock on record. Add anyway?**; Add anyway adds it. *(e2e, unit, SQL)* | ☐ |
| 11 | Offline, ring up an order. Owner menu → Sync & backup → **Emergency export (JSON)** and **(CSV)**. | Both files download. The JSON lists the order under `unsynced`; the CSV opens in Excel with ₱ amounts as plain numbers and correct Manila times. *(e2e, unit)* | ☐ |

## Also check on the Huawei tablet

These can't be verified in the automated tests (they run in desktop Chromium):

- **Installing:** whether Huawei Browser offers "Install app" / "Add to home screen", and whether the installed app opens full screen in landscape. If Huawei Browser can't install PWAs, use Chrome (if Google services are available) or keep a home-screen bookmark.
- **Service worker:** that the app still opens offline after the tablet has been asleep overnight and after a reboot.
- **Storage:** that `[storage] persistent storage granted` appears in the console (remote debugging), and that data survives the browser's "clean up" or phone-manager cleaning. Exclude the browser from Huawei's battery and storage optimisation.
- **Background Sync:** Huawei Browser may not support it. Orders still sync from the app's own timers whenever it's open.
- **Camera:** the QR payment photo opens the rear camera and the photo uploads after sync.
- **Downloads:** where emergency exports land (Files → Downloads) and that they open.
- **Printing:** shift reports and the summary print to A4 via the system print dialog, or save as PDF.
- **Keyboard:** the PIN pad and money keypads work with the on-screen keyboard closed; amount fields bring up a number keyboard.
- **Clock:** Huawei tablets can drift when automatic time is off. Keep automatic date and time on.
