# Choosing the on-screen keyboard for a field

On phones and tablets, the browser picks which keyboard to show from the
field's `inputMode` attribute. On a laptop or desktop it changes nothing.

| `inputMode` value | Keyboard on phone/tablet                          | Use for                                   |
| ----------------- | ------------------------------------------------- | ----------------------------------------- |
| `"decimal"`       | Number pad with a `.` key                         | Peso amounts, percentages                 |
| `"numeric"`       | Number pad, digits only (no `.`, no `-` on iPhone)| Counts, quantities, PINs, reference nos.  |
| `"text"`          | Full keyboard                                     | Names, notes, anything with letters       |
| (left out)        | Full keyboard                                     | Same as `"text"`                          |

## Peso amount fields (`MoneyInput`)

Every peso field uses the shared `MoneyInput` component
(`src/components/MoneyInput.tsx`). It shows the decimal number pad by default.
To change one field, add `inputMode` where that field is used:

```tsx
// Digits only, no "." key
<MoneyInput id="open-float" value={amount} onChange={setAmount} inputMode="numeric" />

// Full keyboard
<MoneyInput id="open-float" value={amount} onChange={setAmount} inputMode="text" />
```

To change the default for **every** peso field at once, edit
`inputMode = "decimal"` in the function's parameter list in `MoneyInput.tsx`.

## Plain `<input>` fields

Find the `<input ...>` and add, change, or remove its `inputMode`:

```tsx
<input id="d-percent" className="input" inputMode="decimal" ... />   // number pad with "."
<input id="d-percent" className="input" inputMode="numeric" ... />   // digits only
<input id="d-percent" className="input" ... />                        // full keyboard
```

Fields with `type="number"` also carry `inputMode="numeric"`; without it
iPhones show the full keyboard on its numbers page instead of the keypad.
If a number field ever needs negative values, remove `inputMode="numeric"`
there, because the iPhone keypad has no minus key.

## Where the main fields live

| Field                                        | File                                          | id / label                |
| -------------------------------------------- | --------------------------------------------- | ------------------------- |
| POS: opening float (start shift)             | `src/components/pos/Shift.tsx`                | `open-float`              |
| POS: cash in/out amount                      | `src/components/pos/Shift.tsx`                | `move-amount`             |
| POS: counted cash (close shift)              | `src/components/pos/Shift.tsx`                | `count-total`             |
| POS: count by denomination                   | `src/components/pos/Shift.tsx`                | `DenominationCounter`     |
| POS: discount percent                        | `src/components/pos/DiscountModal.tsx`        | percent input             |
| POS: discount fixed amount                   | `src/components/pos/DiscountModal.tsx`        | `disc-fixed`              |
| POS: GCash reference number                  | `src/components/pos/CheckoutModal.tsx`        | "Reference number"        |
| POS: owner menu restock/waste quantity       | `src/components/pos/OwnerMenu.tsx`            | "Quantity for …"          |
| Owner: discount percent / amount / sort      | `src/app/admin/discounts/page.tsx`            | `d-percent`, `d-fixed`, `d-sort` |
| Owner: product price / cost / low-stock      | `src/app/admin/products/page.tsx`             | `p-price`, `p-cost`, `p-low` |
| Owner: bundle price / item count             | `src/app/admin/bundles/page.tsx`              | `b-price`, `b-count`      |
| Owner: event prices, starting stock, sort, float, adjust qty, low-stock | `src/app/admin/events/[id]/page.tsx` | `price-…`, `float`, `adj-qty`, `d-low` |
| Owner: close event float / counted / waste   | `src/app/admin/events/[id]/close/page.tsx`    | `float`, `counted`, "Waste for …" |
| Owner: report settings                       | `src/app/admin/reports/Settings.tsx`          | `s-threshold`, `s-retention` |

Tip: search the project for the field's `id` (e.g. `open-float`) to jump
straight to it.
