# Crumb Club POS

Internal, offline-first point of sale for Crumb Club pop-ups.

- **POS (`/pos`)** — one shared tablet, staff unlock with a 4-digit PIN. Every sale is saved on the tablet first and synced in the background, so a dead Wi-Fi never stops a sale.
- **Owner pages (`/admin`)** — products and costs, bundles, events, transaction history and voids, end-of-day close, and a sales and margin dashboard. Usable on a phone.

Stack: Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (Postgres, Auth, RLS, Storage) · Dexie (IndexedDB) · Recharts · Vercel. Money is stored as integer **centavos**; all reporting is in **Asia/Manila**.

---

## 1. Setup

### Requirements
- Node.js 20+ and npm
- A Supabase project (free tier is fine)
- [Supabase CLI](https://supabase.com/docs/guides/cli) to apply migrations
- Optional, for `npm run test:db`: PostgreSQL 16 server binaries (`initdb`, `pg_ctl`). No Docker needed.

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Where to find it | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL | browser + server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) | Supabase → Project Settings → API → anon / publishable key | browser + server |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Supabase → Project Settings → API → service_role / secret key. **Server only — never expose it.** | `/api/device/pair` only (creates the tablet's login) |
| `NEXT_PUBLIC_POS_DEMO` | Leave unset in real use. `1` runs the POS against a fake in-browser server (for demos and e2e tests). | POS |

### Database

```bash
supabase link --project-ref <your-project-ref>
supabase db push            # applies supabase/migrations/*
```

The migrations create every table, RLS policy, RPC function, stock trigger, and a public `photos` storage bucket. In **Supabase → Authentication → Providers → Email**, you may turn off "Confirm email" for faster owner setup. Once the owner account exists, consider turning off new sign-ups.

**Local development** (Docker required by the Supabase CLI):

```bash
supabase start              # runs migrations + supabase/seed.sql
npm install
npm run dev                 # http://localhost:3000
```

The seed creates a dev owner `owner@crumbclub.test` / `crumbclub123` (owner PIN `1234`), staff PINs `1111` and `2222`, seven pastries, four bundles (two fixed, two mix-and-match), and a draft event.

### First run (production)
1. Open the site and create the owner account, then fill in **Set up your business** (name, your name, your 4-digit PIN). Tick "Load a sample menu" if you want example data.
2. Add products (with **cost per piece**), bundles, and staff PINs.
3. Create an event, set prices and starting stock, then **Go live**.
4. On the tablet: sign in as the owner, go to **Set up POS tablet**, tap **Use this tablet as the POS**. The tablet now has its own restricted login. Add it to the home screen (Share → Add to Home Screen / Install app).

### Deploy (Vercel)
Import the repo in Vercel, add the three environment variables, and deploy. Variables are read **at build time**: after adding or changing them, redeploy. No other configuration is needed. `public/sw.js` is served with `no-cache` so updates reach the tablet.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest): money maths, allocation, cart and bundle logic, sync engine with IndexedDB, exports, dashboard insights |
| `npm run test:db` | Applies every migration and the seed to a throwaway Postgres 16, then runs `supabase/tests/*.test.sql` (RLS isolation, idempotent sales, voids returning stock, close/report and dashboard figures) |
| `npm run test:e2e` | Playwright: builds the app in demo mode and tests the POS offline (offline sales, sync on reconnect, cold start without network, bundles, QR Ph). Set `PLAYWRIGHT_CHROMIUM_PATH` if browsers are preinstalled elsewhere. |
| `python3 scripts/make-icons.py` | Regenerates the PWA icons |

---

## 2. How it works

### Roles and security
- **Owner** — Supabase email/password. Full access to their business's data.
- **Device** (the POS tablet) — its own Supabase login, created by an owner through `/pos/pair`. RLS lets it **read** the menu and record sales and stock changes **only through RPCs**. It cannot read staff rows, owner pages, the dashboard, or other businesses.
- **Staff** — 4-digit PIN on the tablet. PINs are bcrypt hashes, set only through `set_staff_pin` and unique per business. They are checked on the tablet against cached hashes so unlocking works offline. A 4-digit PIN identifies who rang up a sale; the tablet's device login is the real security boundary.
- Every table has `business_id` and RLS, so more businesses can be added later.

### Offline and sync (single tablet)
1. **Checkout** writes the sale and an outbox entry to IndexedDB in one transaction. There are no network calls, and the cart resets immediately.
2. **Sync** runs every 15 s, immediately after a sale, when the connection returns, and when the app is reopened. It backs off on failures (2 s up to 60 s).
3. Outbox entries are sent **in order** to idempotent RPCs (`record_sale`, `void_sale`, `adjust_stock`, `set_availability`), keyed by client-generated UUIDs. Retrying after a lost response is a no-op on the server.
4. Failures are handled in two ways:
   - **Transient** (offline, timeout, auth refresh): stops the push and retries later.
   - **Permanent** (the server rejected the data): the entry is marked *failed*, kept, shown in the owner menu, counted as unsynced, and included in backups.
5. After pushing, the tablet **pulls** a snapshot from `pos_snapshot()`: menu, prices, server stock, staff PIN hashes, recent QR refs, and voids made by owners.

**Live stock on the tablet** = the server stock in the last snapshot + every local change the server hadn't seen when that snapshot was taken. A per-device monotonic counter decides "hadn't seen", so a sale is never counted twice even if the ack and the pull land in the same millisecond or the clock changes.

**Server stock** is a ledger: `starting + adjustments − sold (completed sales)`. Triggers keep `event_products.current_stock` up to date. The tablet is the source of truth for what sold: an oversell or a sale that syncs after close is recorded and **flagged**, never rejected.

**Safety nets:**
- A sync pill shows online/offline and the unsynced count.
- A red banner appears when a sale has been unsynced for more than 30 minutes.
- **Download backup** (JSON/CSV) is in the owner menu.
- **Unpair / sign out** is blocked while anything is unsynced.
- The app requests persistent storage so the browser is less likely to evict data.
- The tablet sends a heartbeat (unsynced count) that owners see on the event, close and dashboard pages.

**Service worker** (`public/sw.js`): `/pos` loads from cache (stale-while-revalidate), hashed JS/CSS is cache-first, and product photos are cached. After the POS has loaded online once, it opens with no network.

### Bundles
- Selling a bundle takes stock from its **component pastries**. Bundles have no stock of their own.
- **Fixed bundle:** available while every component has enough for one more.
- **Mix-and-match:** available while the eligible pastries in stock add up to at least the required count. The picker shows remaining stock as staff pick.
- **Revenue allocation:** the bundle price is split across components in proportion to their regular (event) prices, using the **largest-remainder method** on integer centavos. Parts always sum exactly to the price; leftover centavos go to the largest fractional remainders, with ties broken by order.
- The transaction discount is split across all components the same way. Each component row stores `allocated_revenue`, `allocated_discount`, `regular_unit_price`, and `unit_cost` snapshots, so product revenue, margin and "discount vs. buying separately" stay accurate. Single-product lines get a component row too, so all product analytics read one table.
- When loose items in the cart match a bundle that is cheaper, the cart offers a one-tap "Switch to *bundle* and save ₱X".

### Data model (main tables)
- **Setup:** `businesses`, `memberships` (auth user → business, owner/device), `staff`
- **Catalog:** `products`, `bundles`, `bundle_items`
- **Events:** `events`, `event_products`, `event_bundles`
- **Sales:** `transactions` → `transaction_lines` → `transaction_line_components`
- **Stock and cash:** `stock_adjustments` (restock / waste / staff meal / giveaway / correction), `cash_sessions`, `device_heartbeats`

---

## 3. How to run a pop-up day (staff guide)

> Print this page and keep it with the tablet.

**Before you leave for the venue** (owner, with internet)
1. In **Events**, open today's event. Check prices and starting stock, enter the **opening float**, and tap **Go live**.
2. Open the POS on the tablet **while still on Wi-Fi**. Wait for **● Online · all synced**. Today's menu is now saved on the tablet.
3. Charge the tablet and bring a power bank. Keep a phone hotspot available.

**Opening**
1. Open **Crumb Club POS** from the tablet's home screen. It works without internet.
2. Enter **your 4-digit PIN**. Your name shows at the top; every sale is recorded under it.
3. Changing shifts? Tap **👤 your name · Switch** and the next person enters their PIN.

**Making a sale**
1. Tap pastries on the **Pastries** tab or bundles on the **Bundles** tab. Tap again to add more. Use **− / +** in the cart to change amounts.
2. **Pick-your-own boxes** (e.g. "Any 6"): tap the bundle, tap pastries until the counter is full, then **Add to cart**.
3. A purple **💡 Switch to … and save ₱X** button means the customer gets a better price as a bundle. Tap it.
4. Tap **Checkout**:
   - **Cash:** tap **Exact**, a quick amount (₱100 / ₱200 / ₱500 / ₱1,000), or type pesos on the keypad. Give the **change due** shown on screen, then tap **Complete sale**.
   - **QR Ph (GCash):** the customer scans the Crumb Club QR. **Wait until the GCash merchant notification shows the payment.** Type its **reference number**, tick the confirmation box, then tap **Complete sale**. If the screen warns that the reference was already used, check again before continuing.
5. The screen flashes **✓ Sale saved** and is ready for the next customer.
6. Made a mistake? Tap **Undo** at the bottom left within **60 seconds**, then return the customer's payment.
7. Discounts: tap **+ Add discount** in the cart, choose % or ₱, and pick a **reason** (required).

**What the screen tells you**
- Greyed card with **✕ Sold out** or **Unavailable**: can't be sold.
- **⚠ Low**: only a few left.
- **○ Offline · 3 unsynced**: fine. Keep selling; sales are safe on the tablet and upload later.
- **Red banner "sales have not synced"**: connect the tablet to Wi-Fi or a phone hotspot. If you can't, tell an owner. They can download a backup from **⚙ Owner → Sync & backup**.
- **My sales**: your sales and totals for this event.

**Do NOT**
- Clear the browser data, uninstall the app, or "unpair" the tablet while there are unsynced sales.
- Let the tablet run out of battery with unsynced sales. Plug it in.

**Closing** (owner)
1. Connect the tablet to the internet and wait for **● Online · all synced**.
2. On the event page, tap **End of day / close**:
   - Count the cash drawer and enter **Counted cash**. The screen shows whether you're over or short.
   - Open the GCash merchant history and **tick each QR Ph payment** on the list.
   - Enter any **waste** (thrown-away pastries). The rest counts as unsold.
3. Tap **Close event and lock sales**, then **Print** or **Share** the summary.

---

## 4. Troubleshooting
- **POS says "This tablet isn't set up"**: an owner must pair it at `/pos/pair` (needs internet).
- **"Downloading the menu…" forever**: the tablet has never been online with this event live. Connect once.
- **A sale shows "failed to sync"**: the server rejected it. Open **⚙ Owner → Sync & backup** to see the error, download a backup, and use **Retry failed** after fixing the cause.
- **Staff PIN not recognised**: PIN changes reach the tablet on its next sync. Connect it to the internet once.
