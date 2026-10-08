"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { getDb, KV, type ActiveStaff, type CachedSnapshot } from "@/lib/offline/db";
import { SyncEngine, type SyncState } from "@/lib/offline/sync";
import { supabaseTransport } from "@/lib/offline/transport";
import { demoTransport, isPosDemo } from "@/lib/offline/demoTransport";
import { localAvailability, localStock, summarizeOutbox } from "@/lib/offline/stock";
import { isDuplicateQrRef, logPinUseLocally, recordSaleLocally, undoSale, UNDO_WINDOW_MS } from "@/lib/offline/actions";
import {
  addBundle, addProduct, buildMenu, buildSale, bundleState, canIncrement, changeQuantity, priceCart,
  productState, pruneCart, remainingStock,
} from "@/lib/pos/cart";
import { applySuggestion, suggestBundle } from "@/lib/pos/suggest";
import type { CartLine, Discount, MenuBundle, PaymentDetails, SnapshotStaff } from "@/lib/pos/types";
import { formatPeso } from "@/lib/money";
import { errorMessage } from "@/lib/errors";
import { enterOwnerView, restoreDeviceSession } from "@/lib/ownerView";
import { formatDateRange, timeAgo } from "@/lib/time";
import { Logo, Spinner } from "@/components/ui";
import { Modal } from "@/components/Modal";
import { PinPad } from "./PinPad";
import { ItemCard } from "./ItemCard";
import { CartPanel } from "./CartPanel";
import { MixPicker } from "./MixPicker";
import { CheckoutModal } from "./CheckoutModal";
import { DiscountModal } from "./DiscountModal";
import { ShiftPanel } from "./ShiftPanel";
import { OwnerMenu } from "./OwnerMenu";
import { SyncPill, UnsyncedBanner } from "./SyncStatus";
import { useWakeLock } from "./useWakeLock";

const CART_KEY = "crumbclub-pos-cart";
const TAB_KEY = "crumbclub-pos-tab";
const newId = () => crypto.randomUUID();

type Boot = "loading" | "unconfigured" | "unpaired" | "ready";
type LastSale = { id: string; total: number; change: number | null; createdAt: number };

export function PosApp() {
  const db = getDb();
  const [boot, setBoot] = useState<Boot>("loading");
  const engineRef = useRef<SyncEngine | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ syncing: false, online: true, lastSyncAt: null, lastAttemptAt: null, lastError: null, consecutiveFailures: 0 });
  const [now, setNow] = useState(() => Date.now());

  const cached = useLiveQuery(async () => ({ value: await db.getKv<CachedSnapshot>(KV.snapshot) }), []);
  const ops = useLiveQuery(() => db.outbox.toArray(), [], []);
  const activeStaff = useLiveQuery(async () => ({ value: await db.getKv<ActiveStaff | null>(KV.activeStaff) }), []);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState<Discount | null>(null);
  const [tab, setTab] = useState<"bundles" | "pastries">("pastries");
  // Filters within a tab: product subcategory, or bundle type. null = all.
  const [subcategory, setSubcategory] = useState<string | null>(null);
  const [bundleType, setBundleType] = useState<MenuBundle["type"] | null>(null);
  const [voidGate, setVoidGate] = useState(false);
  const [picking, setPicking] = useState<MenuBundle | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [discounting, setDiscounting] = useState(false);
  const [showShift, setShowShift] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [ownerGate, setOwnerGate] = useState(false);
  // pin is kept only while the menu is open, so "Owner dashboard" doesn't ask for it twice.
  const [ownerMenu, setOwnerMenu] = useState<{ staffId: string; pin?: string } | null>(null);
  const [ownerViewGate, setOwnerViewGate] = useState(false);
  const [ownerViewState, setOwnerViewState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const [lastSale, setLastSale] = useState<LastSale | null>(null);
  const [confirmation, setConfirmation] = useState<LastSale | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useWakeLock(boot === "ready");

  // ---- Boot: is this tablet paired? Works offline from the cached session + local flag.
  useEffect(() => {
    if (isPosDemo()) return setBoot("ready");
    if (!isSupabaseConfigured()) return setBoot("unconfigured");
    let cancelled = false;
    (async () => {
      // Coming back from owner view (or it was left open): put the device login back first.
      await restoreDeviceSession().catch(() => false);
      const paired = await db.getKv<{ userId: string }>("device");
      let userId: string | null = null;
      try {
        const { data } = await Promise.race([
          getSupabase().auth.getSession(),
          new Promise<{ data: { session: null } }>((r) => setTimeout(() => r({ data: { session: null } }), 4000)),
        ]);
        userId = data.session?.user.id ?? null;
      } catch {
        // offline; fall back to the local flag
      }
      if (userId && userId !== paired?.userId) await db.setKv("device", { userId });
      if (cancelled) return;
      setBoot(userId || paired ? "ready" : "unpaired");
    })();
    return () => { cancelled = true; };
  }, [db]);

  // ---- Background sync
  useEffect(() => {
    if (boot !== "ready") return;
    const engine = new SyncEngine(db, isPosDemo() ? demoTransport() : supabaseTransport(getSupabase()));
    engineRef.current = engine;
    const unsub = engine.subscribe(setSyncState);
    engine.start();
    // Ask the browser not to evict our data under storage pressure.
    navigator.storage?.persist?.().catch(() => {});
    return () => { unsub(); engine.stop(); engineRef.current = null; };
  }, [boot, db]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- Restore cart and tab after a reload
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CART_KEY) ?? "null");
      if (saved?.cart) { setCart(saved.cart); setDiscount(saved.discount ?? null); }
      const savedTab = localStorage.getItem(TAB_KEY);
      if (savedTab === "bundles" || savedTab === "pastries") setTab(savedTab);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify({ cart, discount })); } catch { /* ignore */ }
  }, [cart, discount]);

  // ---- Derived state
  const snapshot = cached?.value?.snapshot;
  const stock = useMemo(() => localStock(cached?.value, ops), [cached, ops]);
  const availability = useMemo(() => localAvailability(cached?.value, ops), [cached, ops]);
  const menu = useMemo(() => (snapshot ? buildMenu(snapshot, stock, availability) : null), [snapshot, stock, availability]);
  const summary = useMemo(() => summarizeOutbox(ops), [ops]);
  const staff = useMemo(() => snapshot?.staff ?? [], [snapshot]);
  const currentStaff = activeStaff?.value ?? null;
  const event = snapshot?.event ?? null;
  const sellable = !!menu && event?.status === "live";

  // Drop cart lines that no longer exist after a menu refresh.
  useEffect(() => {
    if (menu) setCart((c) => { const pruned = pruneCart(c, menu); return pruned.length === c.length ? c : pruned; });
  }, [menu]);

  // Lock if the active staff member was removed or deactivated.
  useEffect(() => {
    if (currentStaff && snapshot && !snapshot.staff.some((s) => s.id === currentStaff.id)) db.setKv(KV.activeStaff, null);
  }, [currentStaff, snapshot, db]);

  const remaining = useMemo(() => (menu ? remainingStock(menu, cart) : new Map<string, number>()), [menu, cart]);
  const priced = useMemo(() => (menu ? priceCart(cart, menu, discount) : { lines: [], subtotal: 0, discount: 0, total: 0, itemCount: 0 }), [menu, cart, discount]);
  const suggestion = useMemo(() => (menu ? suggestBundle(cart, menu) : null), [menu, cart]);
  const products = useMemo(() => (menu ? [...menu.products.values()].sort((a, b) => a.name.localeCompare(b.name)) : []), [menu]);
  const bundles = useMemo(() => (menu ? [...menu.bundles.values()].sort((a, b) => a.name.localeCompare(b.name)) : []), [menu]);
  const subcategories = useMemo(() => [...new Set(products.map((p) => p.category))].sort(), [products]);
  const bundleTypes = useMemo(() => (["fixed", "mix_match"] as const).filter((t) => bundles.some((b) => b.type === t)), [bundles]);
  const inCartProduct = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) if (l.kind === "product") m.set(l.eventProductId, (m.get(l.eventProductId) ?? 0) + l.quantity);
    return m;
  }, [cart]);
  const inCartBundle = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) if (l.kind === "bundle") m.set(l.eventBundleId, (m.get(l.eventBundleId) ?? 0) + l.quantity);
    return m;
  }, [cart]);

  // ---- Actions
  const eventId = snapshot?.event?.id ?? "";
  const unlock = useCallback(async (s: SnapshotStaff) => {
    await db.setKv<ActiveStaff>(KV.activeStaff, { id: s.id, name: s.name, role: s.role, unlockedAt: Date.now() });
    await logPinUseLocally(db, s.id, "sign_in", eventId);
    engineRef.current?.requestSync();
  }, [db, eventId]);

  const lock = useCallback(async () => {
    await db.setKv(KV.activeStaff, null);
    setShowShift(false);
  }, [db]);

  function chooseTab(t: "bundles" | "pastries") {
    setTab(t);
    setSubcategory(null);
    setBundleType(null);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ }
  }

  function tapBundle(b: MenuBundle) {
    if (b.type === "mix_match") setPicking(b);
    else setCart((c) => addBundle(c, b.event_bundle_id, newId));
  }

  async function completeSale(payment: PaymentDetails) {
    if (!menu || !currentStaff) throw new Error("Not ready");
    const createdAt = new Date();
    const sale = buildSale({ id: newId(), menu, priced, discount, payment, staffId: currentStaff.id, createdAt });
    const summaryText = priced.lines.map((l) => `${l.line.quantity > 1 ? `${l.line.quantity}× ` : ""}${l.name}`).join(", ");
    await recordSaleLocally(db, sale, { staffName: currentStaff.name, summary: summaryText }, createdAt.getTime());
    const done: LastSale = { id: sale.id, total: sale.total_centavos, change: sale.change_given_centavos, createdAt: createdAt.getTime() };
    // Reset immediately for the next customer.
    setCart([]);
    setDiscount(null);
    setCheckingOut(false);
    setLastSale(done);
    setConfirmation(done);
    setTimeout(() => setConfirmation((c) => (c?.id === done.id ? null : c)), 1600);
    engineRef.current?.requestSync();
  }

  /** Undoing (voiding) a sale needs an owner PIN; the owner is recorded as the one who voided it. */
  async function undoLast(owner: SnapshotStaff) {
    setVoidGate(false);
    if (!lastSale || !currentStaff) return;
    try {
      await undoSale(db, lastSale.id, owner.id);
      await logPinUseLocally(db, owner.id, "void_approval", eventId);
      setNotice(`Sale of ${formatPeso(lastSale.total)} undone. Return the customer's payment.`);
      setLastSale(null);
      engineRef.current?.requestSync();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not undo");
    }
  }

  const checkQrDuplicate = useCallback((ref: string) => isDuplicateQrRef(db, ref, snapshot?.recent_qr_refs ?? []), [db, snapshot]);

  async function unpair() {
    const pending = await db.outbox.where("status").notEqual("synced").count();
    if (pending > 0) return setNotice("Can't unpair: some sales haven't synced yet.");
    engineRef.current?.stop();
    if (!isPosDemo()) await getSupabase().auth.signOut({ scope: "local" }).catch(() => {});
    await db.delete().catch(() => {});
    try { localStorage.removeItem(CART_KEY); } catch { /* ignore */ }
    window.location.href = "/pos/pair";
  }

  async function openOwnerView(staffId: string, pin: string) {
    setOwnerViewState({ busy: true, error: null });
    const engine = engineRef.current;
    try {
      // Upload what we can first; sync pauses while the owner pages are open.
      await engine?.syncOnce().catch(() => {});
      engine?.stop();
      await enterOwnerView(staffId, pin);
      await db.setKv(KV.activeStaff, null);
      window.location.href = "/admin/dashboard";
    } catch (e) {
      engine?.start();
      setOwnerViewState({ busy: false, error: errorMessage(e) });
    }
  }

  function showOwnerViewGate() {
    setOwnerViewState({ busy: false, error: null });
    setOwnerViewGate(true);
  }

  /** From the owner menu: reuse the PIN just entered, or ask for it if the menu opened without one. */
  function ownerViewFromMenu() {
    const entered = ownerMenu;
    setOwnerMenu(null);
    showOwnerViewGate();
    if (entered?.pin) void openOwnerView(entered.staffId, entered.pin);
  }

  function openOwnerMenu() {
    if (currentStaff?.role === "owner") setOwnerMenu({ staffId: currentStaff.id });
    else setOwnerGate(true);
  }

  // ---- Screens
  if (boot === "loading" || cached === undefined || activeStaff === undefined) {
    return <main className="flex min-h-dvh items-center justify-center"><Spinner label="Starting POS" /></main>;
  }
  if (boot === "unconfigured") {
    return <Centered><p>Supabase isn&apos;t configured. See the README.</p></Centered>;
  }
  if (boot === "unpaired") {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">This tablet isn&apos;t set up as the POS yet</h1>
        <p className="text-ink-soft">An owner needs to pair it once while online.</p>
        <Link href="/pos/pair" className="btn-primary">Set up this tablet</Link>
      </Centered>
    );
  }
  if (!snapshot) {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">Downloading the menu…</h1>
        <p className="text-ink-soft">{syncState.online ? "This needs the internet once at the start of the day." : "○ Offline. Connect to Wi-Fi or a phone hotspot to download today's menu."}</p>
        {syncState.lastError && <p className="text-danger">✕ {syncState.lastError}</p>}
        <button className="btn-primary" onClick={() => engineRef.current?.syncOnce()}>Try again</button>
      </Centered>
    );
  }

  const header = (
    <header className="flex flex-wrap items-center gap-3 border-b-2 border-crust-dark bg-paper px-4 py-2">
      <Logo className="text-lg text-caramel" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold">{event ? event.name : "No live event"}</p>
        {event && <p className="truncate text-xs text-ink-soft">{formatDateRange(event.starts_on, event.ends_on)}{event.venue ? ` · ${event.venue}` : ""}</p>}
      </div>
      <SyncPill state={syncState} summary={summary} onClick={() => setShowSync(true)} />
      {currentStaff && (
        <>
          <button className="btn-secondary min-h-11 text-sm" onClick={() => setShowShift(true)}>My sales</button>
          <button className="btn-secondary min-h-11 text-sm" onClick={lock} aria-label={`Signed in as ${currentStaff.name}. Switch staff.`}>
            👤 {currentStaff.name} · Switch
          </button>
        </>
      )}
      {!isPosDemo() && (
        <button className="btn-ghost min-h-11 text-sm" onClick={showOwnerViewGate}>
          📊 Owner view
        </button>
      )}
      <button className="btn-ghost min-h-11 text-sm" onClick={openOwnerMenu}>⚙ Owner</button>
    </header>
  );

  const overlays = (
    <>
      <SyncInfo open={showSync} onClose={() => setShowSync(false)} state={syncState} summary={summary} now={now} onSync={() => engineRef.current?.syncOnce()} onOwner={() => { setShowSync(false); openOwnerMenu(); }} />
      <Modal open={ownerGate} onClose={() => setOwnerGate(false)} title="Owner PIN">
        <PinPad staff={staff} requireOwner title="Enter an owner PIN" onUnlock={(s, pin) => {
          setOwnerGate(false);
          setOwnerMenu({ staffId: s.id, pin });
          void logPinUseLocally(db, s.id, "owner_menu", eventId).then(() => engineRef.current?.requestSync());
        }} onCancel={() => setOwnerGate(false)} />
      </Modal>
      <Modal open={ownerViewGate} onClose={() => !ownerViewState.busy && setOwnerViewGate(false)} title="Owner view">
        {!syncState.online ? (
          <div className="space-y-3">
            <p>○ Owner view needs the internet. Selling keeps working offline.</p>
            <button className="btn-secondary" onClick={() => setOwnerViewGate(false)}>Close</button>
          </div>
        ) : ownerViewState.busy ? (
          <Spinner label="Opening owner view" />
        ) : (
          <PinPad
            staff={staff}
            requireOwner
            title="Enter an owner PIN"
            subtitle={
              <>
                {ownerViewState.error ? <span className="font-semibold text-danger">✕ {ownerViewState.error}</span> : "Opens the dashboard, events and reports on this tablet."}
                {summary.unsyncedSales > 0 && <span className="block text-sm">{summary.unsyncedSales} unsynced sale(s) will upload when you return to the POS.</span>}
              </>
            }
            onUnlock={(s, pin) => openOwnerView(s.id, pin)}
            onCancel={() => setOwnerViewGate(false)}
          />
        )}
      </Modal>
      <OwnerMenu open={!!ownerMenu} onClose={() => setOwnerMenu(null)} engine={engineRef.current} state={syncState} summary={summary} menu={menu} ownerStaffId={ownerMenu?.staffId ?? ""} onUnpair={unpair} onOwnerView={isPosDemo() ? undefined : ownerViewFromMenu} />
    </>
  );

  if (!currentStaff) {
    return (
      <main className="flex min-h-dvh flex-col">
        {header}
        <UnsyncedBanner summary={summary} now={now} onOpen={openOwnerMenu} />
        <div className="flex flex-1 items-center justify-center p-4">
          <PinPad staff={staff} title="Enter your PIN" subtitle={snapshot.business.name} onUnlock={unlock} />
        </div>
        {overlays}
      </main>
    );
  }

  if (!sellable || !menu) {
    return (
      <main className="flex min-h-dvh flex-col">
        {header}
        <UnsyncedBanner summary={summary} now={now} onOpen={openOwnerMenu} />
        <Centered>
          <h1 className="text-2xl font-bold">
            {!event ? "No event is live" : event.status === "closed" ? "🔒 This event is closed" : "This event isn't live yet"}
          </h1>
          <p className="text-ink-soft">
            {!event ? "An owner needs to set today's event live." : event.status === "closed" ? "Sales are locked. Unsynced sales will still upload." : "An owner needs to tap “Go live” on the event."}
          </p>
          <button className="btn-primary" onClick={() => engineRef.current?.syncOnce()}>↻ Check again</button>
        </Centered>
        {overlays}
      </main>
    );
  }

  const undoLeft = lastSale ? Math.max(0, Math.ceil((lastSale.createdAt + UNDO_WINDOW_MS - now) / 1000)) : 0;

  return (
    <main className="flex h-dvh flex-col overflow-hidden">
      {header}
      {isPosDemo() && <p className="bg-ink px-4 py-1 text-center text-xs font-bold text-white">DEMO MODE — sales go to a fake in-browser server, not Supabase</p>}
      <UnsyncedBanner summary={summary} now={now} onOpen={openOwnerMenu} />
      {notice && (
        <div role="status" className="flex items-center gap-3 bg-ube-light px-4 py-2 font-semibold text-ube">
          <span className="flex-1">{notice}</span>
          <button className="btn-ghost min-h-10 text-sm" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_minmax(340px,400px)]">
        <section className="flex min-h-0 flex-col" aria-label="Menu">
          <div className="flex gap-2 p-3" role="tablist" aria-label="Menu sections">
            {([["bundles", `📦 Bundles (${bundles.length})`], ["pastries", `🥐 Individual Items (${products.length})`]] as const).map(([t, label]) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => chooseTab(t)}
                className={`btn h-14 flex-1 border-2 text-lg ${tab === t ? (t === "bundles" ? "border-ube bg-ube text-white" : "border-caramel bg-caramel text-white") : "border-crust-dark bg-paper text-ink"}`}>
                {label}
              </button>
            ))}
          </div>
          {tab === "pastries" && subcategories.length > 1 && (
            <FilterChips label="Subcategory" options={subcategories.map((c) => [c, c] as const)} value={subcategory} onChange={setSubcategory} />
          )}
          {tab === "bundles" && bundleTypes.length > 1 && (
            <FilterChips label="Bundle type" options={bundleTypes.map((t) => [t, BUNDLE_TYPE_LABEL[t]] as const)} value={bundleType} onChange={setBundleType} />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" role="tabpanel">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {tab === "pastries" && products.filter((p) => !subcategory || p.category === subcategory).map((p) => {
                const state = productState(menu, p.event_product_id, remaining);
                return (
                  <ItemCard
                    key={p.event_product_id}
                    name={p.name}
                    price={p.price_centavos}
                    photoUrl={p.photo_url}
                    state={state}
                    stockLabel={!p.is_available ? "—" : `${Math.max(0, remaining.get(p.event_product_id) ?? 0)} left`}
                    inCart={inCartProduct.get(p.event_product_id) ?? 0}
                    onTap={() => setCart((c) => addProduct(c, p.event_product_id, newId))}
                  />
                );
              })}
              {tab === "bundles" && bundles.filter((b) => !bundleType || b.type === bundleType).map((b) => {
                const state = bundleState(menu, b.event_bundle_id, remaining);
                const detail = b.type === "fixed"
                  ? b.items.map((i) => `${i.quantity}× ${menu.products.get(i.event_product_id ?? "")?.name ?? "?"}`).join(", ")
                  : `Pick any ${b.required_count}`;
                return (
                  <ItemCard
                    key={b.event_bundle_id}
                    accent="ube"
                    name={b.name}
                    price={b.price_centavos}
                    photoUrl={b.photo_url}
                    detail={detail}
                    state={state}
                    stockLabel={state.canAdd ? `${state.remaining} possible` : ""}
                    inCart={inCartBundle.get(b.event_bundle_id) ?? 0}
                    onTap={() => tapBundle(b)}
                  />
                );
              })}
            </div>
            {tab === "bundles" && bundles.length === 0 && <p className="p-6 text-center text-ink-soft">No bundles at this event.</p>}
          </div>
        </section>
        <div className="min-h-0 max-lg:max-h-[55dvh]">
          <CartPanel
            priced={priced}
            menu={menu}
            discount={discount}
            suggestion={suggestion}
            canIncrement={(id) => canIncrement(menu, cart, id)}
            onChange={(id, d) => setCart((c) => changeQuantity(c, id, d))}
            onClear={() => { setCart([]); setDiscount(null); }}
            onApplySuggestion={() => suggestion && setCart((c) => applySuggestion(c, suggestion, newId))}
            onDiscount={() => setDiscounting(true)}
            onRemoveDiscount={() => setDiscount(null)}
            onCheckout={() => setCheckingOut(true)}
            locked={!sellable}
          />
        </div>
      </div>

      {lastSale && undoLeft > 0 && (
        <div className="fixed bottom-4 left-4 z-10 flex items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-white shadow-xl" role="status">
          <span>✓ Last sale {formatPeso(lastSale.total)}</span>
          <button className="btn min-h-11 bg-white text-ink" onClick={() => setVoidGate(true)}>Undo ({undoLeft}s)</button>
        </div>
      )}

      {confirmation && (
        <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-ok/15" role="status" aria-live="assertive">
          <div className="animate-[popin_180ms_ease-out] rounded-3xl bg-ok px-10 py-8 text-center text-white shadow-2xl">
            <p className="text-6xl" aria-hidden>✓</p>
            <p className="text-2xl font-black">Sale saved</p>
            {confirmation.change != null && confirmation.change > 0 && <p className="text-xl font-bold">Change: {formatPeso(confirmation.change)}</p>}
          </div>
        </div>
      )}

      <Modal open={voidGate && !!lastSale && undoLeft > 0} onClose={() => setVoidGate(false)} title="Void sale">
        <PinPad
          staff={staff}
          requireOwner
          title="Owner PIN to void"
          subtitle={lastSale ? `Undo the sale of ${formatPeso(lastSale.total)}. Stock will be returned.` : undefined}
          onUnlock={(s) => undoLast(s)}
          onCancel={() => setVoidGate(false)}
        />
      </Modal>
      <MixPicker
        bundle={picking}
        menu={menu}
        remaining={remaining}
        onClose={() => setPicking(null)}
        onAdd={(picks) => { setCart((c) => addBundle(c, picking!.event_bundle_id, newId, picks)); setPicking(null); }}
      />
      <CheckoutModal open={checkingOut} total={priced.total} onClose={() => setCheckingOut(false)} onComplete={completeSale} checkQrDuplicate={checkQrDuplicate} />
      <DiscountModal open={discounting} subtotal={priced.subtotal} options={snapshot.discount_options ?? []} onClose={() => setDiscounting(false)} onApply={(d) => { setDiscount(d); setDiscounting(false); }} />
      <ShiftPanel open={showShift} onClose={() => setShowShift(false)} eventId={menu.eventId} staffId={currentStaff.id} staffName={currentStaff.name} />
      {overlays}
    </main>
  );
}

const BUNDLE_TYPE_LABEL: Record<MenuBundle["type"], string> = { fixed: "Fixed", mix_match: "Mix & match" };

function FilterChips<T extends string>({ label, options, value, onChange }: {
  label: string; options: readonly (readonly [T, string])[]; value: T | null; onChange: (v: T | null) => void;
}) {
  const all: readonly (readonly [T | null, string])[] = [[null, "All"], ...options];
  return (
    <div className="flex gap-2 overflow-x-auto px-3 pb-2" role="radiogroup" aria-label={label}>
      {all.map(([v, text]) => (
        <button key={v ?? "__all"} role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={`btn min-h-11 shrink-0 border-2 px-4 text-sm ${value === v ? "border-ink bg-ink text-white" : "border-crust-dark bg-paper text-ink"}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">{children}</div>;
}

function SyncInfo({ open, onClose, state, summary, now, onSync, onOwner }: {
  open: boolean; onClose: () => void; state: SyncState; summary: ReturnType<typeof summarizeOutbox>; now: number; onSync: () => void; onOwner: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Sync status">
      <div className="space-y-3">
        <p className="text-lg font-bold">{state.online ? "● Online" : "○ Offline"}</p>
        <p>{summary.unsyncedSales === 0 ? "✓ All sales are saved to the cloud." : `${summary.unsyncedSales} sale(s) saved on this tablet, waiting to upload.`}</p>
        {summary.oldestUnsyncedAt && <p className="text-sm text-ink-soft">Oldest unsynced: {timeAgo(summary.oldestUnsyncedAt, now)}</p>}
        {summary.failed > 0 && <p className="font-semibold text-danger">✕ {summary.failed} item(s) were rejected by the server. An owner should check the owner menu.</p>}
        <p className="text-sm text-ink-soft">Last successful sync: {state.lastSyncAt ? timeAgo(state.lastSyncAt, now) : "not yet"}</p>
        <p className="text-sm text-ink-soft">Sales are always saved on the tablet first, so you can keep selling offline.</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" onClick={onSync} disabled={state.syncing}>{state.syncing ? "Syncing…" : "↻ Sync now"}</button>
          <button className="btn-secondary" onClick={onOwner}>Owner options</button>
        </div>
      </div>
    </Modal>
  );
}
