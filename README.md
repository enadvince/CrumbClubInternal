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
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Supabase → Project Settings → API → service_role / secret key. **Server only — never expose it.** | Server routes: tablet pairing, owner view on the tablet, co-owner sign-in and adding co-owners |
| `NEXT_PUBLIC_POS_DEMO` | Leave unset in real use. `1` runs the POS against a fake in-browser server (for demos and e2e tests). | POS |

### Database

```bash
supabase link --project-ref <your-project-ref>
supabase db push            # applies supabase/migrations/*
```

The migrations create every table, RLS policy, RPC function, stock trigger, and a public `photos` storage bucket. In **Supabase → Authentication → Providers → Email**, you may turn off "Confirm email" for faster owner setup. The login page only offers sign-up while no business exists; once the owner account exists, also turn off new sign-ups there.

**Local development** (Docker required by the Supabase CLI):

```bash
supabase start              # runs migrations + supabase/seed.sql
npm install
npm run dev                 # http://localhost:3000
```

The seed creates a dev owner `owner@crumbclub.test` / `crumbclub123` (owner PIN `1234`), staff PINs `1111` and `2222`, seven pastries, four bundles (two fixed, two mix-and-match), and a draft event.

### First run (production)
1. Open the site, enter your email, tap **Proceed** and create the owner account, then fill in **Set up your business** (name, your name, your 4-digit PIN). Tick "Load a sample menu" if you want example data.
2. Add products (with **cost per piece**), bundles, and staff PINs.
3. Create an event, set prices and starting stock, then **Go live**.
4. On the tablet: sign in as the owner, go to **Set up POS tablet**, tap **Use this tablet as the POS**. The tablet now has its own restricted login. Add it to the home screen (Share → Add to Home Screen / Install app).

### Deploy (Vercel)
Import the repo in Vercel, add the environment variables, and deploy. Variables are read **at build time**: after adding or changing them, redeploy. `public/sw.js` is served with `no-cache` so updates reach the tablet.

**Deployment Protection:** owners, co-owners and the tablet must be able to open the site without a Vercel account. In Vercel → Project → Settings → Deployment Protection, set Vercel Authentication to **Standard Protection** (previews only) or turn it off. With "All Deployments except Custom Domains" and no custom domain, every link (including email links) asks for a Vercel login. In Supabase → Authentication → URL Configuration, set **Site URL** to the production address too, so Supabase's own emails link there.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest): money maths, allocation, cart and bundle logic, sync engine with IndexedDB, exports, dashboard insights |
| `npm run test:db` | Applies every migration and the seed to a throwaway Postgres 16, then runs `supabase/tests/*.test.sql` (RLS isolation, idempotent sales, voids returning stock, close/report and dashboard figures, co-owner sign-in and lockout, personnel deactivate/remove rules) |
| `npm run test:e2e` | Playwright: builds the app in demo mode and tests the POS offline (offline sales, sync on reconnect, cold start without network, bundles, QR Ph). Set `PLAYWRIGHT_CHROMIUM_PATH` if browsers are preinstalled elsewhere. |
| `python3 scripts/make-icons.py` | Regenerates the PWA icons |

---

## 2. How it works

### Roles and security
- **Main owner** — the person who created the business. Signs in with email and password. Full access to the business's data, and the only one who can manage co-owners.
- **Co-owners** — added by the main owner on **Personnel** (name, email, 4-digit PIN). They sign in with email and PIN, see everything an owner sees, but can't add, remove or reset owners or unpair devices. Behind the scenes each co-owner has a Supabase login with a random password nobody knows; `/api/auth/co-owner` checks the PIN in the database (`co_owner_pin_login`) and returns a session. **Lockout:** 5 wrong PINs lock that co-owner's sign-in for 15 minutes; 5 more wrong PINs after that lock it until the main owner uses **Reset PIN & unlock**. Every co-owner sign-in is recorded in the PIN log. Deactivating a co-owner (main owner only) suspends their access until reactivated; removing one ends it and keeps their name on past sales.
- **Login page** — enter your email and tap **Proceed**: the main owner is asked for a password, a co-owner for a PIN. The page therefore reveals whether an email is registered, which is acceptable for this internal app.
- **Device** (the POS tablet) — its own Supabase login, created by an owner through `/pos/pair`. RLS lets it **read** the menu and record sales and stock changes **only through RPCs**. It cannot read staff rows, owner pages, the dashboard, or other businesses.
- **Personnel page** — owners and staff in one list, filterable by Owners / Staff. Anyone's PIN can be changed (needs the current PIN). Everyone except the main owner can be deactivated/reactivated and removed; co-owners only by the main owner. **Remove** needs the signed-in owner's own PIN (`remove_personnel`); the staff row is kept (inactive) so past sales keep the name.
- **Staff** — 4-digit PIN on the tablet. PINs are bcrypt hashes, set only through `set_staff_pin` (first PIN) or `change_staff_pin` (which requires the current PIN), and unique per business. They are checked on the tablet against cached hashes so unlocking works offline. A 4-digit PIN identifies who rang up a sale; the tablet's device login is the real security boundary.
- **Owner view on the tablet** — tap **📊 Owner view** on the POS and enter an owner PIN to open the owner pages on the tablet. `/api/device/owner-session` (callable only by the device login) checks the PIN on the server, locks the tablet out for 15 minutes after 5 wrong PINs, and returns a session for that owner's own login. The device login is parked in IndexedDB meanwhile. **← Back to POS** (or 5 minutes without a tap) signs the owner out on the tablet and restores the device login. Needs the internet; sync pauses while owner view is open and resumes on return.
- **PIN log** — every successful PIN use (staff sign-in, owner menu, owner view, void approval) is recorded with name, role, time and device. Tablet uses are queued offline and synced like sales. Owners see it under **PIN log**; it has no update or delete privileges, so it can't be edited.
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
- **Setup:** `businesses`, `memberships` (auth user → business, owner/device, co-owner flag and PIN lockout), `staff`
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
1. Tap pastries on the **Individual Items** tab or bundles on the **Bundles** tab. Use the chips under the tabs to filter items by subcategory (set on each product in the owner pages) or bundles by type (fixed / mix & match). Tap again to add more. Use **− / +** in the cart to change amounts.
2. **Pick-your-own boxes** (e.g. "Any 6"): tap the bundle, tap pastries until the counter is full, then **Add to cart**.
3. A purple **💡 Switch to … and save ₱X** button means the customer gets a better price as a bundle. Tap it.
4. Tap **Checkout**:
   - **Cash:** tap **Exact**, a quick amount (₱100 / ₱200 / ₱500 / ₱1,000), or type pesos on the keypad. Give the **change due** shown on screen, then tap **Complete sale**.
   - **QR Ph (GCash):** the customer scans the Crumb Club QR. **Wait until the GCash merchant notification shows the payment.** Type its **reference number**, tick the confirmation box, then tap **Complete sale**. If the screen warns that the reference was already used, check again before continuing.
5. The screen flashes **✓ Sale saved** and is ready for the next customer.
6. Made a mistake? Tap **Undo** at the bottom left within **60 seconds**. An owner enters their PIN to approve the void; then return the customer's payment. Voids from the owner pages also need an owner PIN.
7. Discounts: tap **+ Add discount** in the cart and pick one of the owner's **discount options** (set under **Discounts** in the owner pages), or enter a custom % or ₱ amount with a **reason** (required).

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
