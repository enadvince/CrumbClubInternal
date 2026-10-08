# Offline architecture

How the Crumb Club POS keeps selling without the internet, and how everything it does offline reaches the server exactly once.

The rule behind all of it: **every write lands on the tablet first (IndexedDB), then syncs.** The tablet never waits for the network to finish a sale.

```
 Tablet (browser / installed PWA)                                   Supabase
 ┌───────────────────────────────────────────────┐                ┌───────────────────────────┐
 │ POS UI ──writes──▶ IndexedDB (Dexie)          │                │ Postgres + RLS            │
 │                     sales, shifts, refunds,   │   sync engine  │  idempotent RPCs:         │
 │                     drawer, photos, kv        │ ─────────────▶ │  record_sale, void_order, │
 │                     outbox (sync queue) ──────┼── in order ──▶ │  refund_order, open_shift │
 │                                               │ ◀── snapshot ─ │  ... pos_snapshot()       │
 │ Service worker (Serwist): app shell precached │                │ Storage: payment-proofs,  │
 └───────────────────────────────────────────────┘                │  backups                  │
                                                                  │ pg_cron ─▶ daily-backup   │
                                                                  └───────────────────────────┘
```

## 1. What is cached

### Service worker (`src/sw/sw.ts`, served at `/serwist/sw.js`)

| What | Strategy | Why |
|---|---|---|
| Every hashed JS/CSS chunk, fonts, icons, `manifest.webmanifest` | Precached at install | The POS opens with zero network |
| `/pos`, `/help`, `/~offline` | Precached, revision = commit SHA | Same; refreshed by every deploy |
| Product photos (Supabase public storage) | Cache first, 30 days, 200 entries | Tiles keep their pictures offline |
| Other pages (owner pages, login) | Network only, `/~offline` as fallback | Owner pages need fresh, private data |
| Supabase REST, RPC, auth, storage uploads | **Not handled** | Tokens and writes never touch the HTTP cache |

The worker is a classic script (IIFE), not an ES module, so older Chromium builds such as Huawei Browser can run it.

**Updates never reload on their own.** A new deploy installs a new worker that waits. The POS shows a non-blocking "Update available" banner (`src/components/PwaProvider.tsx`). Tapping "Update now" only activates it when the cart is empty **and** the sync queue is empty. Otherwise it says "Finish syncing orders before updating."

On every load the app calls `navigator.storage.persist()` and logs the result, so the browser is less likely to evict IndexedDB under storage pressure.

### IndexedDB (`src/lib/offline/db.ts`, database `crumbclub-pos`)

Store names are kept from v1 so unsynced data survives upgrades. How they map to the design:

| Design name | Store | Holds |
|---|---|---|
| `orders` | `sales` | Full order snapshot: lines, components, prices **at the time of sale**, discount, totals, payment method and status, staff, device, shift, order number, local timestamps, sync time, refunds and voids |
| `sync_queue` | `outbox` | One entry per pending write: type, payload, status, attempts, next retry time, last error, shift |
| `menu_cache` | `kv.snapshot` | Menu, categories, prices, stock, staff PIN hashes, discount options, `menuVersion`, when it was pulled |
| `device` | `kv.device`, `kv.orderCounters` | Device id, device code (T1...), per-day order counters |
| | `shifts`, `drawer`, `refunds` | Local shift state, cash in/out, refunds and line voids |
| | `photos` | Optional QR payment photos (compressed JPEG bytes) until uploaded |
| | `kv.pinLock` | Owner PIN lockout on this tablet |

The menu is fetched with an RPC (a POST), which an HTTP cache can't hold. IndexedDB is the menu cache: the POS always reads it first (instantly, offline) and every sync refreshes it, which is stale-while-revalidate at the app level.

The order history merges this tablet's IndexedDB orders (so offline orders show at once) with the server's list when online.

## 2. What is queued

Everything below is written to IndexedDB and the outbox in **one IndexedDB transaction**, so it is never half-saved. Each entry has its own client id, which the server uses to ignore repeats.

| Queue type | Created by | RPC | Idempotency key |
|---|---|---|---|
| `shift_open` | Open shift | `open_shift` | shift id |
| `sale` | Checkout | `record_sale` | `client_order_id` (UUID v7) |
| `qr_photo` | Checkout with a QR photo | Storage upload + `attach_payment_photo` | object path |
| `void_order` | Void order (owner PIN) | `void_order` | order id (already voided = no-op) |
| `void` | 60-second Undo (owner PIN) | `void_sale` | order id |
| `refund` | Refund or Void item (owner PIN) | `refund_order` | refund id |
| `drawer` | Cash in / cash out (owner PIN) | `record_drawer_movement` | movement id |
| `shift_close` | Close shift | `close_shift` | shift id |
| `audit` | Every void, refund, cash movement, variance approval, PIN lockout, emergency export | `log_audit` | audit id |
| `adjust`, `availability` | Owner menu stock tools | `adjust_stock`, `set_availability` | adjustment id |
| `pin_use` | Every PIN use | `log_pin_use` | use id |

## 3. How sync resolves (`src/lib/offline/sync.ts`)

1. **Triggers:** the `online` event (old backoffs are cleared), the tab becoming visible, every 30 s while anything waits (sooner when a backoff ends), every 60 s when idle (menu refresh), right after each order, and Background Sync where the browser supports it (not relied on; Huawei Browser may not).
2. **One worker:** a Web Lock (`crumbclub-sync`) lets only one tab sync; other tabs skip.
3. **Connectivity:** `navigator.onLine` is not trusted. Each run first calls `pos_ping()`. If that fails, the tablet is offline and nothing is sent. The ping also measures the tablet's clock offset.
4. **Order:** entries are sent strictly in creation order. A shift opens before its first sale, a sale before its photo, void or refund.
5. **States:** `pending → syncing → synced`, or `failed`. An entry left `syncing` by a killed tab goes back to `pending` and is re-sent; the server ignores the repeat.
6. **Retryable failures** (no response, timeout, 5xx, 429, 408, 401, 404 during a deploy): the entry stays pending with `attempts`, `lastError` and `nextRetryAt`. Backoff is 2 s, 4 s, 8 s, 16 s, 32 s, then 60 s, with ±20% jitter, never more than 5 minutes. An entry that is backing off holds back the ones after it, so order is kept.
7. **Rejected entries** (Postgres 22xxx, 23xxx, P0xxx, 42501, other 4xx): marked `failed` with the server's message, never retried by themselves and never dropped. The status pill turns red ("2 orders need attention"); the sync panel shows each one with **Retry now**.
8. **Pull:** after pushing, the tablet downloads `pos_snapshot()` (menu, prices, stock, staff, device code and counters, owner voids) into `kv.snapshot`.

### Conflicts and how they are settled

| Situation | What happens |
|---|---|
| Same entry sent twice (lost response, crash, forced resync) | Server returns `duplicate`; nothing changes |
| Order number already taken (e.g. a wiped tablet) | Order is kept, number gets a suffix, flagged `order_number_conflict`. The snapshot sends the highest sequence per day so this shouldn't happen |
| Tablet clock wrong | Server keeps its own `created_at`, stores the device time and the measured `clock_offset_ms`, flags drift over 5 minutes |
| Oversell (stock on record ran out) | Sale recorded; tracked products flagged `oversold` |
| Order syncs after the event closed | Recorded and flagged `late_sync` |
| Sale names a shift the server doesn't have | Recorded without it, flagged `shift_missing` |
| Order voided by an owner on the owner pages | Next pull marks the tablet's copy voided |
| A refund or void of an order that never synced | Rejected ("order not found"), shown for review |

### Stock offline

Live stock on the tablet = server stock in the last snapshot + every local change the server hadn't acknowledged when that snapshot was taken (sales, voids, refunds, adjustments). A per-device counter decides "acknowledged before", so nothing is counted twice. Low and out of stock never block a sale; adding something that would go below zero asks "Out of stock on record. Add anyway?".

## 4. Order numbers

Two ids per order:

- `client_order_id`: a UUID v7 made on the tablet. The true unique key and the sync idempotency key.
- `order_number`: `{DEVICE_CODE}-{YYMMDD}-{SEQ}`, e.g. `T1-261008-0042`. Staff call out the last three digits ("042").

The device code is unique per business (`pos_devices`). The day is the Asia/Manila calendar day. The counter is kept per day and bumped in the same IndexedDB transaction that saves the order, so a crash can't reuse a number. A tablet whose clock jumps back carries on from that day's last number. The server only accepts numbers that carry the calling tablet's own code (`record_sale` checks `device_id` against the login).

## 5. Payments offline

- **Cash:** final on the tablet (`payment_status = paid`).
- **QR (InstaPay / GCash QR Ph):** saved as `awaiting_verification` with the reference number and an optional photo (compressed, kept in IndexedDB, uploaded to the private `payment-proofs` bucket on sync). A database trigger sets the status from the payment method, so nothing the tablet sends can mark a QR payment verified. Owners verify them on the owner pages.

## 6. Shifts and the cash drawer

One open shift per tablet. Every order, refund and drawer movement carries the shift id. Close uses a blind count (the expected amount shows only after counting):

```
expected cash = opening float + cash sales − cash refunds + cash in − cash out
```

A variance beyond the business threshold (₱50 by default, Reports → Settings) needs an owner PIN and a note. Closing works offline; the shift report then says **"Provisional: 3 orders not yet synced"** and becomes final by itself when they sync. The tablet builds the report from IndexedDB with the same rules as `shift_report()` on the server (an integration test checks they match).

## 7. Owner PIN, voids, refunds, audit

Owners are the managers. Their PIN hashes (bcrypt) come with the snapshot so approvals work offline. Five wrong owner PINs lock owner PIN entry on that tablet for 5 minutes (kept in IndexedDB, audited). Voids need a reason (wrong item, customer changed mind, duplicate, other + note); a voided order keeps its number and shows struck through. Refunds can be full or partial by item and quantity, in cash or QR; cash refunds lower the expected cash. Everything is written to `audit_log` with the cashier, the approving owner, the device, and both device and server time.

Honest note: a 4-digit PIN hash stored on a tablet can be brute-forced by someone who extracts it. The real security boundary is the tablet's own Supabase login (RLS lets it write only through these RPCs, and only as itself), plus the lockout.

## 8. Backups

- **Nightly:** `pg_cron` runs at 15:30 UTC (23:30 Asia/Manila) and calls the `daily-backup` Edge Function. It writes the day's `orders`, `order_items`, `payments`, `refunds`, `voids`, `shifts`, `drawer_movements` and `audit_log` as CSV to the private `backups` bucket at `YYYY/MM/DD/<business_id>/<file>.csv`, logs the run in `backup_runs`, and deletes backups older than the retention (365 days by default). Rows are chosen by server time, so an order that syncs a day late is still backed up exactly once.
- **Email:** only if `RESEND_API_KEY`, `BACKUP_EMAIL_TO` and `BACKUP_EMAIL_FROM` (or `INVITE_EMAIL_FROM`) are set as Edge Function secrets. Otherwise skipped.
- **Owners:** Reports shows the last successful backup and warns after 48 hours without one; "Run backup now" runs it for their business.
- **Manual export:** Reports → Export (owner PIN): any date range, the same CSV files, plus a printable summary (browser print → Save as PDF).
- **Emergency export:** owner menu on the tablet. Downloads everything on the device, including anything never synced, as JSON or CSV. Last resort only.

CSV rules everywhere: UTF-8 with BOM, one header row, ISO 8601 dates in Asia/Manila (`2026-10-08T14:05:09+08:00`), amounts as plain numbers with 2 decimals.

### Setting up the nightly job (once per Supabase project)

```sql
-- In the SQL editor. Use your project URL and a long random secret.
select vault.create_secret('https://<project-ref>.supabase.co', 'crumbclub_project_url');
select vault.create_secret('<random secret>', 'crumbclub_backup_secret');
```

Then set the same secret on the function and deploy it:

```bash
supabase secrets set BACKUP_CRON_SECRET='<random secret>'
supabase functions deploy daily-backup --no-verify-jwt   # the function checks the secret or an owner's login itself
```

## 9. Adding a new device

1. On the new tablet, open the site and sign in as an owner (needs the internet).
2. Go to **Set up POS tablet** (`/pos/pair`), name it, tap **Use this tablet as the POS**. The tablet gets its own restricted login and claims the next device code (T2, T3...).
3. Add it to the home screen (Install app). Open the POS once while online so the app shell and menu are cached.
4. A staff member unlocks with their PIN and opens a shift.

A tablet paired before device codes existed gets its code automatically on its next sync. If one ever shows "Register this tablet", an owner enters their PIN while online.

**Resetting a tablet** (owner menu → Tablet) is blocked while anything is unsynced. If a tablet can never sync again, take an emergency export first.

## 10. Where things live

| Area | Files |
|---|---|
| Service worker and updates | `src/sw/sw.ts`, `src/app/serwist/[path]/route.ts`, `src/components/PwaProvider.tsx`, `src/lib/pwa.ts` |
| Offline store and queue | `src/lib/offline/db.ts`, `actions.ts`, `numbering.ts`, `pinLock.ts`, `stock.ts`, `backup.ts` |
| Sync | `src/lib/offline/sync.ts`, `backoff.ts`, `transport.ts`, `syncStatus.ts` |
| Shift and refund rules | `src/lib/pos/shift.ts`, `src/lib/pos/refund.ts` |
| POS screens | `src/components/pos/*` |
| Server | `supabase/migrations/20261012*.sql`, `supabase/functions/daily-backup/` |
| Tests | `src/**/*.test.ts` (unit), `src/**/*.integration.test.ts` and `supabase/tests/*.test.sql` (`npm run test:db`), `e2e/` (Playwright) |
