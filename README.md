# Crumb Club POS

Offline-first point of sale for Crumb Club. Installable as a PWA on the counter tablet: the cashier is never blocked by Wi-Fi, and no order is ever lost, duplicated or given a colliding number.

- **POS (`/pos`)**: staff unlock with a 4-digit PIN and open a shift. Every order is saved on the tablet first and synced in the background. Works fully offline: sales, QR payments, voids, refunds, cash in/out and closing the shift.
- **Owner pages (`/admin`)**: products and costs, bundles, events, transactions, end-of-day close, dashboard, reports (low stock, shift reports, backups, exports), PIN log and audit log. Usable on a phone.

Stack: Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (Postgres, Auth, RLS, Storage, Edge Functions, pg_cron) · Dexie (IndexedDB) · Serwist (service worker) · Recharts · Vercel. Money is stored as integer **centavos**; all reporting is in **Asia/Manila**.

How the offline side works: [docs/offline-architecture.md](docs/offline-architecture.md). Manual test run for the tablet: [docs/offline-test-checklist.md](docs/offline-test-checklist.md).

---

## 1. Setup

### Requirements
- Node.js 20+ and npm
- A Supabase project (free tier is fine)
- [Supabase CLI](https://supabase.com/docs/guides/cli) to apply migrations and deploy the backup function
- Optional, for `npm run test:db`: PostgreSQL 16 server binaries (`initdb`, `pg_ctl`). No Docker needed.

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Variable | Where to find it | Used by |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL | browser + server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) | Supabase → Project Settings → API → anon / publishable key | browser + server |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Supabase → Project Settings → API → service_role / secret key. **Server only, never expose it.** | Server routes: tablet pairing, owner view on the tablet, co-owner sign-in and adding co-owners |
| `NEXT_PUBLIC_SUPPORT_URL` | Optional. Where "Contact support" points (UTM tags are added). Defaults to Waddle Labs. | public pages |
| `NEXT_PUBLIC_POS_DEMO` | Leave unset in real use. `1` runs the POS against a fake in-browser server (for demos and e2e tests). | POS |

Edge Function secrets (Supabase → Edge Functions → Secrets, or `supabase secrets set`):

| Secret | Purpose |
|---|---|
| `BACKUP_CRON_SECRET` | Optional. Not needed when the Vault secret `crumbclub_backup_secret` exists (the function checks against Vault). Only for projects without Vault. |
| `RESEND_API_KEY`, `BACKUP_EMAIL_TO`, `BACKUP_EMAIL_FROM` | Optional. Email a summary of each nightly backup with the orders CSV attached. Without them, no email is sent. |

### Database

```bash
supabase link --project-ref <your-project-ref>
supabase db push            # applies supabase/migrations/*
```

The migrations create every table, RLS policy, RPC, stock trigger, the storage buckets (`photos` public; `payment-proofs` and `backups` private) and the nightly backup schedule. In **Supabase → Authentication → Providers → Email**, you may turn off "Confirm email" for faster owner setup. The login page only offers sign-up while no business exists; once the owner account exists, also turn off new sign-ups there.

### Nightly backups (once per project)

```sql
-- SQL editor: the project URL and a random secret generated in the database, stored in Vault.
select vault.create_secret('https://<project-ref>.supabase.co', 'crumbclub_project_url');
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'crumbclub_backup_secret');
```

```bash
supabase functions deploy daily-backup --no-verify-jwt
```

The function checks the secret (cron) or an owner's login (the "Run backup now" button) itself. Reports → Backups shows the last successful run.

**Local development** (Docker required by the Supabase CLI):

```bash
supabase start              # runs migrations + supabase/seed.sql
npm install
npm run dev                 # http://localhost:3000
```

The seed creates a dev owner `owner@crumbclub.test` / `crumbclub123` (owner PIN `1234`), staff PINs `1111` and `2222`, seven pastries, four bundles, and a draft event.

### First run (production)
1. Open the site, enter your email, tap **Proceed** and create the owner account, then fill in **Set up your business** (name, your name, your 4-digit PIN). Tick "Load a sample menu" if you want example data.
2. Add products (with **cost per piece**, stock tracking and low stock alert), bundles, and staff and co-owners on **Personnel**.
3. Create an event, set prices and starting stock, then **Go live**.
4. On the tablet: sign in as the owner, go to **Set up POS tablet**, tap **Use this tablet as the POS**. The tablet gets its own restricted login and a code (T1, T2...). Install the app (browser menu → Install app / Add to home screen).

### Deploy (Vercel)
Import the repo in Vercel, add the environment variables, and deploy. Variables are read **at build time**: after adding or changing them, redeploy. The service worker (`/serwist/sw.js`) is served with `no-cache` so updates reach the tablet; they install in the background and wait for **Update now**.

**Deployment Protection:** owners, co-owners and the tablet must be able to open the site without a Vercel account. In Vercel → Project → Settings → Deployment Protection, set Vercel Authentication to **Standard Protection** (previews only) or turn it off. In Supabase → Authentication → URL Configuration, set **Site URL** to the production address too.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run typecheck` | `tsc --noEmit` for the app and the service worker |
| `npm test` | Unit tests (Vitest): order numbers, backoff, sync states, idempotent re-send, PIN lockout, offline stock, refunds, expected cash, variance rule, CSV rules, backup files, exports and more |
| `npm run test:db` | Applies every migration and the seed to a throwaway Postgres 16, runs `supabase/tests/*.test.sql` (RLS isolation, idempotent sales, voids and refunds returning stock, order numbers and devices, payments, shifts, backups, reports, co-owner sign-in and lockout, personnel rules), then the integration tests (`src/**/*.integration.test.ts`): the real sync engine against the real SQL functions (3 offline orders then a forced resync, offline void and refund with audit and stock, a full offline shift matching the server's report) |
| `npm run test:e2e` | Playwright: builds the app in demo mode and tests the POS offline (cold start, order numbers, sync panel, voids, refunds, PIN lockout, shift close, emergency export, dark mode, 404). Set `PLAYWRIGHT_CHROMIUM_PATH` if browsers are preinstalled elsewhere. |
| `python3 scripts/make-icons.py` | Regenerates the PWA icons |

---

## 2. How it works

### Roles and security
- **Main owner**: the person who created the business. Signs in with email and password. Full access to the business's data, and the only one who can manage co-owners.
- **Co-owners**: added by the main owner on **Personnel** (name, email, 4-digit PIN). They sign in with email and PIN and see everything an owner sees, but can't add, remove or reset owners or unpair devices. 5 wrong PINs lock that co-owner's sign-in for 15 minutes; 5 more lock it until the main owner uses **Reset PIN & unlock**.
- **Owners are the managers**: any active owner (main or co-owner) approves voids, refunds, cash out and large cash variances with their PIN. A deactivated co-owner can't approve.
- **Login page**: enter your email and tap **Proceed**. The main owner is asked for a password, a co-owner for a PIN.
- **Personnel page**: owners and staff in one list. PIN changes need the current PIN; removing someone needs the signed-in owner's PIN, and keeps their name on past sales.
- **Device** (a POS tablet): its own Supabase login, created by an owner through `/pos/pair`, with a device code. RLS lets it read the menu and write only through RPCs, and only as itself.
- **Staff**: 4-digit PIN on the tablet. PINs are bcrypt hashes, checked on the tablet against cached hashes so unlocking works offline.
- **Owner PIN on the tablet**: approvals work offline against the cached hashes. Five wrong owner PINs lock owner PIN entry on that tablet for 5 minutes.
- **Owner view on the tablet**: **📊 Owner view** opens the owner pages on the tablet with an owner PIN (needs the internet; 5 minutes idle returns to the POS).
- **PIN log and audit log**: every PIN use, void, refund, cash movement, variance approval and export is recorded. Neither can be edited or deleted.
- Every table has `business_id` and RLS.

### Offline and sync (summary)
1. Checkout writes the order and a queue entry to IndexedDB in one transaction, with the next order number (`T1-261008-0042`). No network calls.
2. The sync engine sends the queue in order to idempotent RPCs, keyed by client ids. It retries with backoff (2 s up to 60 s, never more than 5 minutes), confirms connectivity with a health check, and never lets two tabs send at once.
3. Anything the server rejects is kept, shown in red in the sync panel with **Retry now**, and included in the emergency export.
4. After pushing, the tablet pulls the menu, stock, staff and device state.

Details, conflict handling and how to add a device: [docs/offline-architecture.md](docs/offline-architecture.md).

### Bundles
- Selling a bundle takes stock from its **component pastries**.
- **Revenue allocation:** the bundle price is split across components in proportion to their regular prices (largest-remainder method on integer centavos). The order discount is split the same way. Refunds use a cumulative-floor rule so partial refunds add up exactly.

### Data model (main tables)
- **Setup:** `businesses`, `memberships` (owner/device, co-owner flag and PIN lockout), `staff`, `pos_devices`
- **Catalog:** `products`, `bundles`, `bundle_items`
- **Events:** `events`, `event_products`, `event_bundles`
- **Sales:** `transactions` (with `client_order_id`, `order_number`, `device_id`, `shift_id`, `payment_status`) → `transaction_lines` → `transaction_line_components`
- **After the sale:** `refunds`, `refund_lines`, `refund_components`
- **Cash and stock:** `shifts`, `drawer_movements`, `cash_sessions`, `stock_adjustments`, `device_heartbeats`
- **Records:** `pin_uses`, `audit_log`, `backup_runs`

---

## 3. How to run a pop-up day (staff guide)

> Print this page and keep it with the tablet.

**Before you leave for the venue** (owner, with internet)
1. In **Events**, open today's event. Check prices and starting stock, enter the **opening float**, and tap **Go live**.
2. Open the POS on the tablet **while still on Wi-Fi**. Wait for the green **All synced** pill. Today's menu is now saved on the tablet.
3. Charge the tablet and bring a power bank. Keep a phone hotspot available.

**Opening**
1. Open **Crumb Club POS** from the tablet's home screen. It works without internet.
2. Enter **your 4-digit PIN**.
3. **Open shift:** count the cash in the drawer (total, or note by note) and tap **Open shift and start selling**.
4. Changing cashiers? Tap **👤 your name · Switch** and the next person enters their PIN. The shift stays open.

**Making a sale**
1. Tap pastries or bundles, or type in **Search products and bundles**. Use **− / +** in the cart to change amounts.
2. **Pick-your-own boxes**: tap the bundle, tap pastries until the counter is full, then **Add to cart**.
3. A purple **💡 Switch to … and save ₱X** button means the customer gets a better price as a bundle. Tap it.
4. Tap **Checkout**:
   - **Cash:** tap **Exact**, a quick amount, or type pesos. Give the **change due** shown, then **Complete sale**.
   - **QR Ph (GCash / InstaPay):** wait for the GCash merchant notification, type its **reference number**, tick the confirmation box, optionally take a **photo of the payment**, then **Complete sale**. QR payments are saved as **awaiting verification** until an owner checks them.
5. The screen shows **✓ Sale saved** and the order number, e.g. **#042** (T1-261008-0042). Call out the three digits.
6. Mistake right away? Tap **Undo** within **60 seconds**. An owner enters their PIN to approve.

**Voids and refunds** (owner PIN needed)
- Tap **🧾 Orders**, search the number, then **Void order**, **Void item** or **Refund**. Pick a reason (wrong item, customer changed mind, duplicate, other with a note). For refunds, choose the items, how many, and cash or QR. A voided order keeps its number and shows crossed out.

**What the screen tells you**
- **Low: 3 left** (amber): running low. **Out of stock** (red): none left on record. You can still sell it after confirming, if it's really there.
- Pill **All synced** (green): everything is on the server. **3 orders pending sync** (amber): saved, uploading soon. **Syncing...** (blue). **Offline: orders saved on this device** (grey): keep selling. **orders need attention** (red): tap it, read the reason, try **Retry now**, and tell an owner if it keeps failing.
- Red banner "orders have not synced": connect to Wi-Fi or a hotspot.

**Cash in and cash out:** tap **💵 Shift**. Cash out (e.g. paying a supplier) needs an owner PIN.

**Closing your shift**
1. Tap **💵 Shift → Close shift**. Count every note and coin first; the expected amount shows only after you enter your count.
2. If the difference is more than ₱50, add a note and ask an owner for their PIN.
3. The shift report shows. **Provisional** means some orders haven't synced yet; it becomes **Final** by itself. Print it if needed.

**Do NOT**
- Clear the browser data, uninstall the app, or reset the tablet while anything is unsynced.
- Let the tablet run out of battery with unsynced orders. Plug it in.

**End of the event** (owner)
1. Connect the tablet and wait for **All synced**.
2. On the event page, tap **End of day / close**: enter **Counted cash**, tick each QR payment against the GCash history (this marks them verified), enter any **waste**, then **Close event and lock sales**.

---

## 4. Troubleshooting
- **"This tablet isn't set up"**: an owner must pair it at `/pos/pair` (needs internet).
- **"Register this tablet"**: the tablet has no device code yet. Connect to the internet; an owner enters their PIN.
- **"Downloading the menu..." forever**: the tablet has never been online with this event live. Connect once.
- **An order needs attention**: tap the red pill to see the reason, fix it if you can, and use **Retry now**. If the tablet can never sync again, an owner uses **Emergency export** in the owner menu and contacts support.
- **Update available won't update**: finish the current sale and wait for **All synced**; updates never interrupt an order.
- **Staff PIN not recognised**: PIN changes reach the tablet on its next sync. Connect once.
- **No backup warning in Reports**: check Supabase → Edge Functions → daily-backup logs, and that both Vault secrets exist (and, if you set `BACKUP_CRON_SECRET` on the function, that it matches). **Run backup now** tests it.
