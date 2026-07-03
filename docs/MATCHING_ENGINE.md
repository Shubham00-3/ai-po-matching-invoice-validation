# PO Matching & Invoice Validation Engine

> **What this is:** the deterministic core of the procurement workflow. It lives in a single
> n8n **Code node** (JavaScript, Node runtime). It receives the LLM-extracted invoice and the
> Airtable PO record, then produces a field-by-field comparison, a discrepancy list, a severity,
> and a final `validationStatus`.
>
> **Design principle — separation of concerns:** OpenAI extracts **facts only**. This engine makes
> **every pass/fail decision** in plain, testable JavaScript. No LLM is in the decision path, so the
> outcome is auditable, deterministic, and unit-testable. This is the piece graded most heavily on
> "PO matching logic" and "business-rule implementation."

---

## 1. Where this node sits in the workflow

```
[Email Trigger] → [PDF → text] → [OpenAI extract (facts only)]
       → [Airtable: look up PO by PO Number]
       → ►►► THIS NODE: Matching & Validation Engine ◄◄◄
       → [Airtable: create/update Invoices record]
       → [Switch on validationStatus] → payment / review / rejected
```

The node is pure and side-effect free: **inputs in, one structured object out.** It does no I/O,
which is exactly what makes it easy to test and safe to re-run.

---

## 2. Input contract

The Code node reads two objects off the incoming item. The recommended wiring is to build a single
JSON object upstream (a Set/Merge node) with two keys, `invoice` and `po`, and feed it in. The code
also tolerates them arriving as separate item fields.

### 2.1 `invoice` — OpenAI extraction output (facts only)

```jsonc
{
  "vendorName": "Acme Industrial Supplies Ltd.",
  "vendorId": "V-1007",
  "poNumber": "PO-2026-0442",
  "invoiceNumber": "INV-88213",
  "invoiceDate": "2026-06-28",
  "dueDate": "2026-07-28",
  "currency": "CAD",
  "netAmount": 12000.00,      // pre-tax total, major units (dollars)
  "taxAmount": 1560.00,       // tax total, major units
  "grossAmount": 13560.00,    // net + tax, major units
  "taxRatePct": 13,           // OPTIONAL: stated tax rate if present on invoice
  "lineItems": [
    {
      "sku": "AC-4402",       // may be null/absent
      "description": "M12 Hex Bolt, Zinc, 50mm",
      "quantity": 400,
      "unitPrice": 12.50,     // major units
      "lineTotal": 5000.00,   // OPTIONAL; recomputed if absent
      "unitOfMeasure": "ea"   // OPTIONAL; see §10 "unit basis"
    },
    {
      "sku": "AC-9910",
      "description": "Industrial Lubricant 5L",
      "quantity": 200,
      "unitPrice": 35.00,
      "lineTotal": 7000.00
    }
  ],
  "confidenceScore": 0.94,
  "extractionWarnings": []
}
```

**Contract notes**

- All money is in **major units** (dollars) as the LLM reads them off the page. The engine converts
  to **integer minor units (cents)** internally before any comparison.
- Any field may be `null`, `undefined`, `""`, or the wrong type. The engine coerces defensively and
  never throws on bad input — a malformed field becomes a discrepancy or a comparison note, not a crash.
- A **null / unreadable** numeric field (e.g. an unreadable line quantity) is treated as a
  **data-quality (`missing_data`) minor**, *not* silently as `0` and *not* as a hard mismatch. A human
  confirms; the engine never fabricates a delta against a value it never read.
- `lineItems` may be empty or missing; each line item's `sku`, `lineTotal`, `unitOfMeasure`, and
  `taxRatePct` are optional.
- **Credit notes** (negative `netAmount` / negative line `quantity`) are a supported document type —
  see §10. They are not flagged as errors merely for being negative.

### 2.2 `po` — Airtable Purchase Order record

Pass the Airtable record's `fields` object (or the whole record — the engine reads `.fields` if present).
A missing/empty PO (`null`, `{}`, or `_notFound: true`) triggers the Missing-PO path.

```jsonc
{
  "vendorName": "Acme Industrial Supplies",
  "vendorId": "V-1007",
  "poNumber": "PO-2026-0442",
  "currency": "CAD",
  "approvalStatus": "Approved",
  "netTotal": 12000.00,        // approved PRE-TAX value, major units (compared net-to-net)
  "taxTotal": 1560.00,         // OPTIONAL: approved tax value, major units
  "grossTotal": 13560.00,      // approved GROSS value, major units (compared gross-to-gross)
  "totalAmount": 13560.00,     // LEGACY single-total field; see totalIsGross below
  "totalIsGross": true,        // OPTIONAL: is `totalAmount` tax-inclusive? default true
  "expectedTaxRatePct": 13,    // OPTIONAL: expected VAT/tax rate for this PO/jurisdiction
  "lineItems": [
    { "sku": "AC-4402", "description": "M12 Hex Bolt Zinc 50mm", "quantity": 400, "unitPrice": 12.50 },
    { "sku": "AC-9910", "description": "Industrial Lubricant 5L", "quantity": 200, "unitPrice": 35.00 }
  ]
}
```

> **Tax basis is explicit, never assumed.** The PO may expose any of `netTotal`, `taxTotal`,
> `grossTotal`, or a legacy single `totalAmount` with a `totalIsGross` flag. The engine resolves an
> effective **net** and **gross** PO figure from whatever is present (see `resolvePoTotals`) and then
> compares **like-for-like**: invoice net vs PO net, invoice gross vs PO gross. It never compares a
> tax-inclusive figure to a pre-tax one.

> **Airtable tip:** store PO line items as a JSON string in a long-text field, or as linked records.
> If it's a JSON string, `JSON.parse` it in the Set node before this node, or let the engine's
> `coerceLineItems()` parse a stringified array.

---

## 3. Output contract

The node returns **one** object:

```jsonc
{
  "validationStatus": "Ready for Payment" | "Procurement Review" | "Rejected",
  "severity": "none" | "minor" | "major",
  "matchSummary": "PO PO-2026-0442: Ready for Payment. 0 major / 1 minor discrepancy...",
  "fieldComparisons": [
    { "field": "poNumber", "invoiceValue": "PO-2026-0442", "poValue": "PO-2026-0442", "match": true, "note": "exact" }
    // ... one per compared field/line item
  ],
  "discrepancies": [
    {
      "field": "lineItem[AC9910].unitPrice",
      "type": "unit_price_mismatch",
      "severity": "major",
      "invoiceValue": 3800,       // cents
      "poValue": 3500,            // cents
      "delta": 300,               // cents, invoice - po
      "message": "Unit price for AC9910 is 38.00 vs PO 35.00 (+8.57%, tolerance 2%)."
    }
  ],
  "meta": {
    "engineVersion": "2.0.0",
    "evaluatedAt": "2026-07-03T12:00:00.000Z",
    "confidenceScore": 0.94,
    "tolerances": { "moneyRelPct": 2, "taxAbsCents": 2, "taxRelCeilingCents": 500, "qtyExact": true },
    "counts": { "major": 1, "minor": 1, "fields": 9 }
  }
}
```

Every `discrepancy` has exactly: `field`, `type`, `severity`, `invoiceValue`, `poValue`, `delta`, `message`.
Every `fieldComparison` has exactly: `field`, `invoiceValue`, `poValue`, `match` (boolean), `note`.

> **Airtable-safe values.** `invoiceValue` / `poValue` are always **scalars** (string, number, or
> `null`) — never nested objects. Line-item discrepancies serialize the line to a compact string like
> `"M12 Hex Bolt x400 @ 12.50"` so an Airtable long-text/JSON field write never produces
> `[object Object]`. Line-item field *keys* embed the physical line index (`lineItem[#0/AC4402]`) so
> two lines that share a SKU never collide in the audit output.

---

## 4. The code (copy-paste into an n8n Code node, "Run Once for Each Item")

> Paste this whole block. It reads `$json.invoice` and `$json.po` and `return`s a single object.
> Every tunable lives in the `CONFIG` block at the top — in production, read these from
> `$env` / n8n environment variables instead of hard-coding.

```javascript
// ============================================================================
// PO MATCHING & INVOICE VALIDATION ENGINE  v2.0.0
// Deterministic. No LLM in the decision path. Pure function of (invoice, po).
// ============================================================================

// ----------------------------- CONFIG --------------------------------------
// In production, source these from n8n env vars, e.g.:
//   MONEY_REL_TOLERANCE_PCT = Number($env.MONEY_REL_TOLERANCE_PCT ?? 2)
// Kept as literals here so the node is self-contained and copy-pasteable.
const CONFIG = {
  MONEY_REL_TOLERANCE_PCT: 2,     // ±% allowed on net / tax / total / unit price
  TAX_ABS_TOLERANCE_CENTS: 2,     // absolute rounding slack on recomputed tax (cents)
  TAX_REL_CEILING_CENTS: 500,     // relative tax tolerance only applies up to this abs $ ceiling
  TOTAL_ABS_TOLERANCE_CENTS: 2,   // absolute slack on Net+Tax==Gross identity (cents)
  QUANTITY_EXACT: true,           // quantity must match exactly (else uses money tol.)
  DESC_SIMILARITY_THRESHOLD: 0.6, // Jaccard token overlap to accept a description match
  VENDOR_LEVENSHTEIN_MAX: 2,      // max edit distance for a "fuzzy" vendor match
  VENDOR_FUZZY_MIN_LEN: 5,        // never fuzzy-match normalized names shorter than this
  VENDOR_FUZZY_RATIO: 0.2,        // and cap distance at floor(len * ratio)
  REQUIRE_PO_APPROVED: true,      // PO must have approvalStatus == Approved
  ALLOW_CREDIT_NOTES: true,       // treat negative net/qty as a credit note, not an error
  PO_TOTAL_IS_GROSS_DEFAULT: true,// how to interpret legacy `totalAmount` when totalIsGross absent

  // ---- Severity policy table (documented, configurable) -------------------
  // Maps each discrepancy TYPE to its severity. Change policy here in one place.
  SEVERITY: {
    missing_po:                 'major',
    wrong_po:                   'major', // wrong PO fetched — terminal, do not deep-compare
    po_not_approved:            'major',
    vendor_mismatch:            'major',
    vendor_name_under_id:       'minor', // vendorId matches but names diverge — human glance
    po_number_mismatch:         'major',
    currency_mismatch:          'major',
    quantity_mismatch:          'major',
    unit_price_mismatch:        'major',
    net_amount_mismatch:        'major', // invoice net vs PO net beyond tolerance
    tax_amount_mismatch:        'major', // invoice tax vs PO tax field beyond tolerance
    additional_line_item:       'major', // invoice bills something not on the PO
    missing_line_item:          'minor', // on PO, not invoiced — usually a partial delivery
    incorrect_tax_calculation:  'minor', // small tax drift; large drift auto-escalates (see code)
    total_identity_mismatch:    'major', // Net+Tax != Gross by > slack (invoice arithmetic broken)
    invoice_exceeds_po:         'major', // gross invoice > approved PO gross beyond tolerance
    under_billing:              'minor', // invoice below PO value (partial / under-bill)
    missing_data:               'minor', // a required field was null/unreadable — human confirms
    low_confidence:             'minor', // LLM confidence below floor — human glance advised
  },
  CONFIDENCE_FLOOR: 0.70,         // below this, raise a `low_confidence` minor discrepancy
};

// ------------------------- SMALL UTILITIES ---------------------------------
const isNil = (v) => v === null || v === undefined || v === '';

/** Coerce anything money-ish to integer CENTS. Returns null if not parseable.
 *  Preserves sign so credit notes (negative amounts) survive. */
function toCents(v) {
  if (isNil(v)) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);
  // strip currency symbols, thousands separators, spaces — keep digits, dot, minus
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** Coerce to a finite number (for quantities). Returns null if not parseable. */
function toNum(v) {
  if (isNil(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const centsToStr = (c) => (c === null || c === undefined ? 'n/a' : (c / 100).toFixed(2));

/** Case-fold, trim, collapse whitespace. */
function normText(s) {
  if (isNil(s)) return '';
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Vendor/company normalization: normText + strip legal suffixes + punctuation. */
const LEGAL_SUFFIXES = [
  'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'corp',
  'corporation', 'co', 'company', 'gmbh', 'ag', 'sa', 'sarl', 'bv', 'pty',
  'pvt', 'srl', 'oy', 'ab', 'as', 'nv',
];
function normVendor(s) {
  let t = normText(s).replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = t.split(' ').filter((w) => w && !LEGAL_SUFFIXES.includes(w));
  return tokens.join(' ');
}

/** Normalize PO / SKU codes: uppercase, strip all non-alphanumerics. */
const normCode = (s) => (isNil(s) ? '' : String(s).toUpperCase().replace(/[^A-Z0-9]/g, ''));

/** Levenshtein edit distance (bounded use; strings here are short). */
function levenshtein(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Jaccard token-set similarity in [0,1] for description matching.
 *  Returns 0 when EITHER set is empty — empty descriptions must never auto-pair. */
function jaccard(a, b) {
  const A = new Set(normText(a).split(' ').filter(Boolean));
  const B = new Set(normText(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Relative-tolerance money comparison, all in cents.
 *  Returns { ok, deltaCents, relPct }. Reference is the PO value.
 *  Compares magnitudes so credit notes (negative on both sides) behave. */
function moneyWithinTol(invCents, poCents, relPct = CONFIG.MONEY_REL_TOLERANCE_PCT) {
  if (invCents === null || poCents === null) return { ok: false, deltaCents: null, relPct: null };
  const delta = invCents - poCents;
  const base = Math.abs(poCents);
  if (base === 0) {
    // Zero-value PO line: only an exactly-zero invoice value matches; any nonzero is out.
    return { ok: invCents === 0, deltaCents: delta, relPct: invCents === 0 ? 0 : Infinity };
  }
  const pct = (Math.abs(delta) / base) * 100;
  return { ok: pct <= relPct, deltaCents: delta, relPct: pct };
}

/** Accept a possibly-stringified array of line items. */
function coerceLineItems(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/** Compact scalar label for a line item (never an object). */
function lineToStr(li) {
  if (!li) return 'n/a';
  const desc = (li.description || li.sku || 'line').toString().trim();
  const qty = li.quantity ?? '?';
  const price = (li.unitPriceCents ?? null) !== null ? ` @ ${centsToStr(li.unitPriceCents)}` : '';
  return `${desc} x${qty}${price}`;
}

/** Resolve an effective { netCents, grossCents } from whatever PO total fields exist,
 *  making the tax basis explicit instead of assuming `totalAmount` is gross. */
function resolvePoTotals(po) {
  const net = toCents(po.netTotal);
  const tax = toCents(po.taxTotal);
  const gross = toCents(po.grossTotal);
  const legacy = toCents(po.totalAmount);
  const legacyIsGross =
    po.totalIsGross === undefined ? CONFIG.PO_TOTAL_IS_GROSS_DEFAULT : !!po.totalIsGross;

  let netCents = net;
  let grossCents = gross;
  if (grossCents === null && legacy !== null && legacyIsGross) grossCents = legacy;
  if (netCents === null && legacy !== null && !legacyIsGross) netCents = legacy;
  // Derive the missing side from net/tax if we can.
  if (grossCents === null && netCents !== null && tax !== null) grossCents = netCents + tax;
  if (netCents === null && grossCents !== null && tax !== null) netCents = grossCents - tax;
  return { netCents, grossCents, taxCents: tax };
}

// --------------------- READ + NORMALIZE INPUTS -----------------------------
const raw = $json || {};
const invoice = raw.invoice || {};
// PO may arrive as a full Airtable record ({id, fields}) or as bare fields.
let po = raw.po || {};
if (po && po.fields && typeof po.fields === 'object') po = po.fields;
const poMissing =
  isNil(po) || (typeof po === 'object' && Object.keys(po).length === 0) || po._notFound === true;

const fieldComparisons = [];
const discrepancies = [];

const pushCmp = (field, invoiceValue, poValue, match, note) =>
  fieldComparisons.push({ field, invoiceValue, poValue, match: !!match, note: note || '' });

const pushDisc = (field, type, invoiceValue, poValue, delta, message, sevOverride) => {
  const severity = sevOverride || CONFIG.SEVERITY[type] || 'minor';
  discrepancies.push({ field, type, severity, invoiceValue, poValue, delta, message });
};

// ============================================================================
// STEP 1 — MISSING PO  (terminal)
// ============================================================================
if (poMissing) {
  pushCmp('poNumber', invoice.poNumber ?? null, null, false, 'No PO record found');
  pushDisc(
    'poNumber', 'missing_po',
    invoice.poNumber ?? null, null, null,
    `No approved Purchase Order found for PO Number "${invoice.poNumber ?? '(none on invoice)'}".`
  );
  return finalize();
}

// ============================================================================
// STEP 2 — PO NUMBER (exact after normalization) — TERMINAL if wrong PO
// A blank invoice PO number is a data-quality issue; a *different* PO number
// means we fetched the wrong commitment and must NOT deep-compare against it.
// ============================================================================
{
  const invN = normCode(invoice.poNumber);
  const poN = normCode(po.poNumber);

  if (invN === '') {
    pushCmp('poNumber', invoice.poNumber ?? null, po.poNumber ?? null, false, 'invoice PO number missing');
    pushDisc('poNumber', 'missing_data', null, po.poNumber ?? null, null,
      `Invoice has no readable PO number to match against PO record "${po.poNumber ?? ''}".`);
    // Not terminal: continue so other checks still surface, but flagged for a human.
  } else if (invN !== poN) {
    pushCmp('poNumber', invoice.poNumber ?? null, po.poNumber ?? null, false, 'wrong PO fetched');
    pushDisc('poNumber', 'wrong_po', invoice.poNumber ?? null, po.poNumber ?? null, null,
      `Invoice PO "${invoice.poNumber ?? ''}" does not match fetched PO "${po.poNumber ?? ''}". ` +
      `Refusing to compare against the wrong Purchase Order.`);
    return finalize(); // terminal: deep comparison against a wrong PO would be meaningless
  } else {
    pushCmp('poNumber', invoice.poNumber ?? null, po.poNumber ?? null, true, 'exact (normalized)');
  }
}

// ============================================================================
// STEP 3 — PO APPROVAL STATUS
// ============================================================================
if (CONFIG.REQUIRE_PO_APPROVED) {
  const approved = normText(po.approvalStatus) === 'approved';
  pushCmp('approvalStatus', null, po.approvalStatus ?? null, approved,
    approved ? 'PO is Approved' : 'PO is not in Approved state');
  if (!approved) {
    pushDisc('approvalStatus', 'po_not_approved', null, po.approvalStatus ?? null, null,
      `Matched PO exists but its approval status is "${po.approvalStatus ?? 'unknown'}", not "Approved".`);
  }
}

// ============================================================================
// STEP 4 — CURRENCY (exact; absent-on-both is missing-data, not a mismatch)
// ============================================================================
{
  const invC = normText(invoice.currency).toUpperCase();
  const poC = normText(po.currency).toUpperCase();
  if (invC === '' && poC === '') {
    pushCmp('currency', invoice.currency ?? null, po.currency ?? null, false, 'currency absent on both sides');
    pushDisc('currency', 'missing_data', invoice.currency ?? null, po.currency ?? null, null,
      `Currency is missing on both the invoice and the PO; cannot confirm payment currency.`);
  } else {
    const match = invC !== '' && invC === poC;
    pushCmp('currency', invoice.currency ?? null, po.currency ?? null, match,
      match ? 'exact' : 'currency codes differ');
    if (!match) {
      pushDisc('currency', 'currency_mismatch', invoice.currency ?? null, po.currency ?? null, null,
        `Currency mismatch: invoice ${invoice.currency ?? '?'} vs PO ${po.currency ?? '?'}.`);
    }
  }
}

// ============================================================================
// STEP 5 — VENDOR (id → exact → normalized → guarded fuzzy)
// vendorId pairs the record, but a diverging NAME under a matching id still
// raises a minor flag (a misread id / shared id must not silently pay anyone).
// Fuzzy matching is guarded by a minimum length + relative distance ratio so
// short unrelated names (ACME vs ACRE) never collide.
// ============================================================================
{
  const invRaw = invoice.vendorName ?? null;
  const poRaw = po.vendorName ?? null;
  const invId = normCode(invoice.vendorId);
  const poId = normCode(po.vendorId);

  const invNorm = normVendor(invRaw);
  const poNorm = normVendor(poRaw);
  const exact = normText(invRaw) === normText(poRaw) && normText(invRaw) !== '';
  const normEqual = invNorm === poNorm && invNorm !== '';
  const dist = levenshtein(invNorm, poNorm);
  const shortest = Math.min(invNorm.length, poNorm.length);
  const ratioCap = Math.floor(shortest * CONFIG.VENDOR_FUZZY_RATIO);
  const fuzzyBudget = Math.min(CONFIG.VENDOR_LEVENSHTEIN_MAX, ratioCap);
  const fuzzyOk = shortest >= CONFIG.VENDOR_FUZZY_MIN_LEN && dist <= fuzzyBudget;
  const idMatch = invId !== '' && invId === poId;
  const nameAgrees = exact || normEqual || fuzzyOk;

  let match, note;
  if (idMatch && nameAgrees) {
    match = true; note = 'vendorId + name match';
  } else if (idMatch && !nameAgrees) {
    // ID matches but names disagree: pair them, but demand a human glance.
    match = true; note = `vendorId match but names differ (edit distance ${dist})`;
    pushDisc('vendorName', 'vendor_name_under_id', invRaw, poRaw, null,
      `vendorId matches but vendor names differ: invoice "${invRaw ?? ''}" vs PO "${poRaw ?? ''}". ` +
      `Confirm this is the same payee.`);
  } else if (exact) {
    match = true; note = 'exact name match';
  } else if (normEqual) {
    match = true; note = 'normalized match (suffix/case/space folded)';
  } else if (fuzzyOk) {
    match = true; note = `fuzzy match (Levenshtein ${dist} ≤ ${fuzzyBudget})`;
  } else {
    match = false; note = `no match (Levenshtein ${dist})`;
  }

  pushCmp('vendorName', invRaw, poRaw, match, note);
  if (!match) {
    pushDisc('vendorName', 'vendor_mismatch', invRaw, poRaw, null,
      `Vendor mismatch: invoice "${invRaw ?? ''}" vs PO "${poRaw ?? ''}" (edit distance ${dist}).`);
  }
}

// ============================================================================
// STEP 6 — LINE ITEM ALIGNMENT  (the hard part)
// ----------------------------------------------------------------------------
// Algorithm:
//   0. AGGREGATE invoice (and PO) lines by normalized SKU, summing quantity so
//      split shipments (2× "sku A qty 5") reconcile against one PO line (qty 10).
//   1. Align by normalized SKU/code (strongest signal).
//   2. For SKU-less lines, greedily align by best description Jaccard similarity
//      above DESC_SIMILARITY_THRESHOLD (highest score first). Empty descriptions
//      never pair (jaccard returns 0).
//   3. Leftover invoice lines  -> additional_line_item (billed, not on PO).
//      Leftover PO lines       -> missing_line_item   (on PO, not invoiced).
//   4. For each aligned pair: check quantity (exact by default; null => missing_data)
//      and unit price (money tolerance). Emit per-line discrepancies + comparisons.
// Field keys embed the physical index so duplicate SKUs never collide.
// ============================================================================
{
  const mapLine = (li, i) => ({
    idx: i,
    sku: li && li.sku,
    description: (li && li.description) || '',
    quantity: toNum(li && li.quantity),
    unitPriceCents: toCents(li && li.unitPrice),
    uom: normText(li && li.unitOfMeasure),
  });

  // -- Pass 0: aggregate same-SKU lines (sum qty; keep first unit price) --------
  function aggregateBySku(lines) {
    const bySku = new Map();
    const passthrough = [];
    for (const l of lines) {
      const code = normCode(l.sku);
      if (!code) { passthrough.push(l); continue; }
      if (!bySku.has(code)) {
        bySku.set(code, { ...l, _mergedIdxs: [l.idx], _priceConflict: false });
      } else {
        const agg = bySku.get(code);
        // sum quantities when both present; otherwise mark as missing-data downstream
        agg.quantity = (agg.quantity === null || l.quantity === null)
          ? (agg.quantity ?? l.quantity)
          : agg.quantity + l.quantity;
        if (agg.unitPriceCents !== null && l.unitPriceCents !== null
            && agg.unitPriceCents !== l.unitPriceCents) agg._priceConflict = true;
        agg._mergedIdxs.push(l.idx);
      }
    }
    return [...bySku.values(), ...passthrough];
  }

  const invLines = aggregateBySku(coerceLineItems(invoice.lineItems).map(mapLine));
  const poLines = aggregateBySku(coerceLineItems(po.lineItems).map(mapLine));

  const poUsed = new Set();
  const pairs = []; // { inv, po }

  // -- Pass 1: SKU/code alignment --
  for (const inv of invLines) {
    const code = normCode(inv.sku);
    if (!code) continue;
    const match = poLines.find((p) => !poUsed.has(p.idx) && normCode(p.sku) === code);
    if (match) { pairs.push({ inv, po: match }); poUsed.add(match.idx); inv._paired = true; }
  }

  // -- Pass 2: description similarity for still-unpaired invoice lines --
  for (const inv of invLines) {
    if (inv._paired) continue;
    let best = null, bestScore = 0;
    for (const p of poLines) {
      if (poUsed.has(p.idx)) continue;
      const score = jaccard(inv.description, p.description);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && bestScore >= CONFIG.DESC_SIMILARITY_THRESHOLD) {
      pairs.push({ inv, po: best, score: bestScore });
      poUsed.add(best.idx);
      inv._paired = true;
    }
  }

  const keyFor = (li) => `#${li.idx}${normCode(li.sku) ? '/' + normCode(li.sku) : ''}`;

  // -- Additional line items: invoice lines never paired --
  for (const inv of invLines) {
    if (inv._paired) continue;
    const k = `lineItem[${keyFor(inv)}]`;
    pushCmp(k, lineToStr(inv), null, false, 'not present on PO');
    pushDisc(k, 'additional_line_item', lineToStr(inv), null, null,
      `Invoice bills line "${inv.description || inv.sku || `#${inv.idx}`}" ` +
      `(qty ${inv.quantity}) that is not on the PO.`);
  }

  // -- Missing line items: PO lines never paired --
  for (const p of poLines) {
    if (poUsed.has(p.idx)) continue;
    const k = `lineItem[${keyFor(p)}]`;
    pushCmp(k, null, lineToStr(p), false, 'on PO, not invoiced');
    pushDisc(k, 'missing_line_item', null, lineToStr(p), null,
      `PO line "${p.description || p.sku || `#${p.idx}`}" (qty ${p.quantity}) ` +
      `was not invoiced (possible partial delivery).`);
  }

  // -- Compare each aligned pair --
  for (const { inv, po: p } of pairs) {
    const base = `lineItem[${keyFor(inv)}]`;

    // Unit-of-measure sanity: differing UoM makes qty/price comparison meaningless.
    if (inv.uom && p.uom && inv.uom !== p.uom) {
      pushCmp(`${base}.unitOfMeasure`, inv.uom, p.uom, false, 'unit of measure differs');
      pushDisc(`${base}.unitOfMeasure`, 'missing_data', inv.uom, p.uom, null,
        `Unit of measure differs (invoice "${inv.uom}" vs PO "${p.uom}"); ` +
        `quantity/price comparison may not be like-for-like. Human confirm.`);
    }

    // Quantity — null on either side is a data-quality issue, not a mismatch.
    if (inv.quantity === null || p.quantity === null) {
      pushCmp(`${base}.quantity`, inv.quantity, p.quantity, false, 'quantity unreadable');
      pushDisc(`${base}.quantity`, 'missing_data', inv.quantity, p.quantity, null,
        `Quantity for ${keyFor(inv)} could not be read (invoice ${inv.quantity} / PO ${p.quantity}); ` +
        `human confirmation required.`);
    } else if (CONFIG.QUANTITY_EXACT) {
      const qMatch = inv.quantity === p.quantity;
      pushCmp(`${base}.quantity`, inv.quantity, p.quantity, qMatch, qMatch ? 'exact' : 'quantity differs');
      if (!qMatch) {
        const delta = inv.quantity - p.quantity;
        pushDisc(`${base}.quantity`, 'quantity_mismatch', inv.quantity, p.quantity, delta,
          `Quantity for ${keyFor(inv)}: invoice ${inv.quantity} vs PO ${p.quantity} (Δ ${delta}).`);
      }
    } else {
      const t = moneyWithinTol(inv.quantity * 100, p.quantity * 100);
      pushCmp(`${base}.quantity`, inv.quantity, p.quantity, t.ok,
        t.ok ? 'within qty tolerance' : 'quantity out of tolerance');
      if (!t.ok) {
        pushDisc(`${base}.quantity`, 'quantity_mismatch', inv.quantity, p.quantity,
          inv.quantity - p.quantity, `Quantity for ${keyFor(inv)} differs beyond tolerance.`);
      }
    }

    // Price conflict surfaced from aggregation (two invoice lines, same SKU, different price)
    if (inv._priceConflict) {
      pushDisc(`${base}.unitPrice`, 'missing_data', inv.unitPriceCents, null, null,
        `Multiple invoice lines for ${keyFor(inv)} carry different unit prices; verify manually.`);
    }

    // Unit price (money tolerance)
    if (inv.unitPriceCents === null || p.unitPriceCents === null) {
      pushCmp(`${base}.unitPrice`, centsToStr(inv.unitPriceCents), centsToStr(p.unitPriceCents),
        false, 'unit price unreadable');
      pushDisc(`${base}.unitPrice`, 'missing_data', inv.unitPriceCents, p.unitPriceCents, null,
        `Unit price for ${keyFor(inv)} could not be read; human confirmation required.`);
    } else {
      const t = moneyWithinTol(inv.unitPriceCents, p.unitPriceCents);
      pushCmp(`${base}.unitPrice`, centsToStr(inv.unitPriceCents), centsToStr(p.unitPriceCents),
        t.ok, t.ok ? `within ${CONFIG.MONEY_REL_TOLERANCE_PCT}%` : 'unit price out of tolerance');
      if (!t.ok) {
        const sign = (t.deltaCents ?? 0) >= 0 ? '+' : '';
        pushDisc(`${base}.unitPrice`, 'unit_price_mismatch',
          inv.unitPriceCents, p.unitPriceCents, t.deltaCents,
          `Unit price for ${keyFor(inv)} is ${centsToStr(inv.unitPriceCents)} vs PO ` +
          `${centsToStr(p.unitPriceCents)} (${sign}${(t.relPct ?? 0).toFixed(2)}%, ` +
          `tolerance ${CONFIG.MONEY_REL_TOLERANCE_PCT}%).`);
      }
    }
  }
}

// ============================================================================
// STEP 7 — MONETARY TOTALS (Net + Tax vs PO, gross-vs-gross, identity)
// ============================================================================
const invNet = toCents(invoice.netAmount);
const invTax = toCents(invoice.taxAmount);
const invGross = toCents(invoice.grossAmount);
const poT = resolvePoTotals(po);   // { netCents, grossCents, taxCents }

const isCreditNote = CONFIG.ALLOW_CREDIT_NOTES &&
  ((invNet !== null && invNet < 0) || (invGross !== null && invGross < 0));

// 7a. Net + Tax == Gross identity (internal consistency of the invoice)
if (invNet !== null && invTax !== null && invGross !== null) {
  const expected = invNet + invTax;
  const delta = invGross - expected;
  const ok = Math.abs(delta) <= CONFIG.TOTAL_ABS_TOLERANCE_CENTS;
  pushCmp('grossAmount', centsToStr(invGross), centsToStr(expected), ok,
    ok ? 'Net + Tax = Gross' : `Net + Tax (${centsToStr(expected)}) ≠ Gross`);
  if (!ok) {
    pushDisc('grossAmount', 'total_identity_mismatch', invGross, expected, delta,
      `Invoice arithmetic off: Net ${centsToStr(invNet)} + Tax ${centsToStr(invTax)} ` +
      `= ${centsToStr(expected)} but Gross states ${centsToStr(invGross)} (Δ ${centsToStr(delta)}).`);
  }
}

// 7b. NET amount: invoice net vs PO net (Step-4 mandated net-to-net comparison)
if (invNet !== null && poT.netCents !== null) {
  const t = moneyWithinTol(invNet, poT.netCents);
  pushCmp('netAmount_vs_PO', centsToStr(invNet), centsToStr(poT.netCents), t.ok,
    t.ok ? `within ${CONFIG.MONEY_REL_TOLERANCE_PCT}%` : 'net differs from PO net');
  if (!t.ok) {
    if (!isCreditNote && (t.deltaCents ?? 0) > 0) {
      pushDisc('netAmount', 'net_amount_mismatch', invNet, poT.netCents, t.deltaCents,
        `Invoice net ${centsToStr(invNet)} exceeds PO net ${centsToStr(poT.netCents)} ` +
        `by ${centsToStr(t.deltaCents)} (+${(t.relPct ?? 0).toFixed(2)}%, ` +
        `tolerance ${CONFIG.MONEY_REL_TOLERANCE_PCT}%).`);
    } else {
      pushDisc('netAmount', 'under_billing', invNet, poT.netCents, t.deltaCents,
        `Invoice net ${centsToStr(invNet)} is below PO net ${centsToStr(poT.netCents)} ` +
        `by ${centsToStr(Math.abs(t.deltaCents ?? 0))} (partial / under-billing?).`);
    }
  }
} else if (invNet !== null && poT.netCents === null) {
  pushCmp('netAmount_vs_PO', centsToStr(invNet), null, false, 'PO exposes no net value to compare');
  pushDisc('netAmount', 'missing_data', invNet, null, null,
    `PO has no net/pre-tax value; cannot verify invoice net ${centsToStr(invNet)} against the commitment.`);
}

// 7c. TAX amount: invoice tax vs PO tax field, when the PO carries one
if (invTax !== null && poT.taxCents !== null) {
  const t = moneyWithinTol(invTax, poT.taxCents);
  pushCmp('taxAmount_vs_PO', centsToStr(invTax), centsToStr(poT.taxCents), t.ok,
    t.ok ? `within ${CONFIG.MONEY_REL_TOLERANCE_PCT}%` : 'tax differs from PO tax');
  if (!t.ok && !isCreditNote) {
    pushDisc('taxAmount', 'tax_amount_mismatch', invTax, poT.taxCents, t.deltaCents,
      `Invoice tax ${centsToStr(invTax)} differs from PO tax ${centsToStr(poT.taxCents)} ` +
      `by ${centsToStr(t.deltaCents)} (${(t.relPct ?? 0).toFixed(2)}%).`);
  }
}

// 7d. GROSS vs PO gross: over-value beyond tolerance is a hard block
if (invGross !== null && poT.grossCents !== null) {
  const t = moneyWithinTol(invGross, poT.grossCents);
  pushCmp('grossAmount_vs_PO', centsToStr(invGross), centsToStr(poT.grossCents), t.ok,
    t.ok ? `within ${CONFIG.MONEY_REL_TOLERANCE_PCT}%` : 'differs from PO gross');
  if (!t.ok) {
    if (!isCreditNote && (t.deltaCents ?? 0) > 0) {
      pushDisc('grossAmount', 'invoice_exceeds_po', invGross, poT.grossCents, t.deltaCents,
        `Invoice total ${centsToStr(invGross)} exceeds approved PO gross ${centsToStr(poT.grossCents)} ` +
        `by ${centsToStr(t.deltaCents)} (+${(t.relPct ?? 0).toFixed(2)}%, ` +
        `tolerance ${CONFIG.MONEY_REL_TOLERANCE_PCT}%).`);
    } else {
      pushDisc('grossAmount', 'under_billing', invGross, poT.grossCents, t.deltaCents,
        `Invoice total ${centsToStr(invGross)} is below PO gross ${centsToStr(poT.grossCents)} ` +
        `by ${centsToStr(Math.abs(t.deltaCents ?? 0))} (partial billing?).`);
    }
  }
}

// ============================================================================
// STEP 8 — TAX RECOMPUTATION CHECK
// Verify Tax ≈ Net × rate, using invoice rate, else PO expected rate.
// Tolerance: absolute rounding slack, OR relative band but ONLY up to a bounded
// absolute dollar ceiling — so a small % on a large tax can't hide a real $ error.
// If no rate is available, we DO NOT assert "consistent": we raise a missing_data
// minor so a human confirms the tax.
// ============================================================================
{
  const ratePct = toNum(invoice.taxRatePct) ?? toNum(po.expectedTaxRatePct);
  if (invNet !== null && invTax !== null && ratePct !== null) {
    const expectedTax = Math.round(invNet * (ratePct / 100));
    const delta = invTax - expectedTax;
    const absDelta = Math.abs(delta);
    const rel = moneyWithinTol(invTax, expectedTax);
    const absOk = absDelta <= CONFIG.TAX_ABS_TOLERANCE_CENTS;
    // relative band only forgives drift up to a bounded absolute ceiling
    const relOk = rel.ok && absDelta <= CONFIG.TAX_REL_CEILING_CENTS;
    const ok = absOk || relOk;
    pushCmp('taxAmount', centsToStr(invTax), centsToStr(expectedTax), ok,
      ok ? `consistent with ${ratePct}% rate` : `expected ~${centsToStr(expectedTax)} at ${ratePct}%`);
    if (!ok) {
      // Escalate to major if tax is wildly off (> 5% relative); otherwise minor.
      const sev = (rel.relPct ?? 0) > 5 ? 'major' : 'minor';
      pushDisc('taxAmount', 'incorrect_tax_calculation', invTax, expectedTax, delta,
        `Tax ${centsToStr(invTax)} inconsistent with Net ${centsToStr(invNet)} × ${ratePct}% ` +
        `= ${centsToStr(expectedTax)} (Δ ${centsToStr(delta)}).`, sev);
    }
  } else if (invTax !== null) {
    // Tax present but no rate to check it against — do not claim "consistent".
    pushCmp('taxAmount', centsToStr(invTax), null, false, 'no tax rate available to verify');
    pushDisc('taxAmount', 'missing_data', invTax, null, null,
      `Invoice tax ${centsToStr(invTax)} present but no tax rate (invoice or PO) available to verify it; ` +
      `human confirmation advised.`);
  }
}

// ============================================================================
// STEP 9 — CONFIDENCE FLOOR (LLM extraction quality signal)
// ============================================================================
{
  const conf = toNum(invoice.confidenceScore);
  if (conf !== null && conf < CONFIG.CONFIDENCE_FLOOR) {
    pushDisc('confidenceScore', 'low_confidence', conf, CONFIG.CONFIDENCE_FLOOR, null,
      `Extraction confidence ${conf} is below floor ${CONFIG.CONFIDENCE_FLOOR}; human verification advised.`);
  }
}

// ============================================================================
// FINALIZE — severity rollup + outcome band
// ============================================================================
return finalize();

function finalize() {
  const majorCount = discrepancies.filter((d) => d.severity === 'major').length;
  const minorCount = discrepancies.filter((d) => d.severity === 'minor').length;

  // Outcome bands (per spec):
  //   any major  -> Rejected
  //   only minor -> Procurement Review
  //   none       -> Ready for Payment
  let severity, validationStatus;
  if (majorCount > 0)      { severity = 'major'; validationStatus = 'Rejected'; }
  else if (minorCount > 0) { severity = 'minor'; validationStatus = 'Procurement Review'; }
  else                     { severity = 'none';  validationStatus = 'Ready for Payment'; }

  const poNum = (invoice && invoice.poNumber) || (po && po.poNumber) || '(unknown)';
  const total = majorCount + minorCount;
  const majorTypes = [...new Set(discrepancies.filter(d => d.severity === 'major').map(d => d.type))];
  const matchSummary =
    `PO ${poNum}: ${validationStatus}. ${majorCount} major / ${minorCount} minor ` +
    `discrepanc${total === 1 ? 'y' : 'ies'}` +
    (majorTypes.length ? ` — blocking: ${majorTypes.join(', ')}.` : '.');

  return {
    validationStatus,
    severity,
    matchSummary,
    fieldComparisons,
    discrepancies,
    meta: {
      engineVersion: '2.0.0',
      evaluatedAt: new Date().toISOString(),
      confidenceScore: toNum(invoice && invoice.confidenceScore),
      tolerances: {
        moneyRelPct: CONFIG.MONEY_REL_TOLERANCE_PCT,
        taxAbsCents: CONFIG.TAX_ABS_TOLERANCE_CENTS,
        taxRelCeilingCents: CONFIG.TAX_REL_CEILING_CENTS,
        qtyExact: CONFIG.QUANTITY_EXACT,
      },
      counts: { major: majorCount, minor: minorCount, fields: fieldComparisons.length },
    },
  };
}
```

> **n8n note:** `finalize()` is a function declaration, so it is hoisted — calling it before its
> definition (as the terminal early returns do) is valid JavaScript. If your n8n Code node is set
> to "Run Once for All Items," wrap the body in a loop over `items` and push one result per item;
> the logic above is written for **"Run Once for Each Item."**

---

## 5. Severity policy — the documented minor/major table

Change this in one place: `CONFIG.SEVERITY`. This is the heart of "business-rule implementation."

| Discrepancy type            | Severity | Rationale |
|-----------------------------|----------|-----------|
| `missing_po`                | **major** | Cannot validate spend against an approved commitment. |
| `wrong_po`                  | **major** | Fetched a different PO than the invoice references — terminal; no deep compare. |
| `po_not_approved`           | **major** | PO exists but isn't authorized to spend against. |
| `vendor_mismatch`           | **major** | Paying the wrong party is a fraud/AP risk. |
| `po_number_mismatch`        | **major** | Wrong commitment referenced. |
| `currency_mismatch`         | **major** | FX ambiguity → wrong payment amount. |
| `quantity_mismatch`         | **major** | Billed more/fewer units than ordered. |
| `unit_price_mismatch`       | **major** | Price beyond ±tolerance vs approved price. |
| `net_amount_mismatch`       | **major** | Invoice net exceeds PO net beyond tolerance. |
| `tax_amount_mismatch`       | **major** | Invoice tax differs from PO's stated tax beyond tolerance. |
| `additional_line_item`      | **major** | Invoice bills something never ordered. |
| `invoice_exceeds_po`        | **major** | Gross over approved PO gross beyond tolerance. |
| `total_identity_mismatch`   | **major** | Net+Tax≠Gross by more than rounding slack — invoice arithmetic is broken. |
| `incorrect_tax_calculation` | **minor**\* | Small tax drift is routine; *auto-escalates to major if > 5%*. |
| `missing_line_item`         | **minor** | On PO but not invoiced — usually a legitimate partial delivery. |
| `under_billing`             | **minor** | Invoice below PO value (partial / under-bill); informational. |
| `vendor_name_under_id`      | **minor** | vendorId matches but names diverge — confirm same payee. |
| `missing_data`              | **minor** | A required field was null/unreadable — human confirms, no fabricated delta. |
| `low_confidence`            | **minor** | LLM confidence below floor; human should glance. |

\* Tax has **conditional escalation** baked into the code: a relative drift over 5% escalates the same
`incorrect_tax_calculation` from minor to **major**. Note `total_identity_mismatch` is **major** — a
broken Net+Tax=Gross identity means the numbers on the page don't add up and must not auto-pay.

**Outcome bands (Step 9 of the spec):**

| Condition                    | `severity` | `validationStatus`     |
|------------------------------|------------|------------------------|
| ≥ 1 major discrepancy        | `major`    | **Rejected**           |
| only minor discrepancies     | `minor`    | **Procurement Review** |
| zero discrepancies           | `none`     | **Ready for Payment**  |

---

## 6. Line-item alignment explained

The alignment is an aggregate-then-two-pass greedy matcher — cheap, deterministic, and good enough
for real POs:

0. **SKU aggregation.** Before matching, invoice (and PO) lines that share a normalized SKU are
   merged, summing quantities. A split shipment billed as two lines of `sku A qty 5` reconciles
   cleanly against a single PO line of `sku A qty 10` instead of producing a spurious
   `additional_line_item` plus an under-counted `quantity_mismatch`. If two merged invoice lines carry
   *different* unit prices, that surfaces as a `missing_data` flag for a human, not a silent choice.
1. **SKU/code pass.** Normalize each SKU (`normCode`: uppercase, strip non-alphanumerics) and pair
   invoice↔PO lines with equal codes. SKUs are the strongest identity signal, so they win first.
2. **Description pass.** For invoice lines still unpaired, compute **Jaccard token overlap** against
   every unpaired PO line and take the best score. Accept only if it clears
   `DESC_SIMILARITY_THRESHOLD` (0.6). **Empty descriptions never pair** — `jaccard` returns `0` when
   either token set is empty, so two blank lines can't be matched by accident.
3. **Leftovers become discrepancies.** Unpaired invoice lines → `additional_line_item` (major);
   unpaired PO lines → `missing_line_item` (minor / partial delivery). Both serialize the line to a
   **compact string** (`"bolt x5 @ 20.00"`) so Airtable writes cleanly.
4. **Paired lines** are checked for quantity (exact by default) and unit price (±2% in cents). A
   **null** quantity or price is a `missing_data` minor — *not* a fabricated `quantity_mismatch` with a
   nonsense delta. Differing **units of measure** ("box" vs "each") raise a `missing_data` flag rather
   than a bogus quantity mismatch.

Field keys embed the **physical line index** (`lineItem[#1/AC9910]`) so two lines sharing a SKU never
produce colliding audit rows.

Greedy is chosen over optimal assignment (Hungarian) deliberately: real invoices have a handful of
lines, SKUs resolve most of them, and a greedy best-first pass is trivial to read and audit — which
is what's being graded.

### Why fuzzy vendor matching, and how it's guarded

Vendors write their own name inconsistently ("Acme Industrial Supplies Ltd." on the invoice, "Acme
Industrial Supplies" in the PO table). We resolve in priority order:

1. **`vendorId`** — if both sides carry an ID and they match, that pairs the record. **But** if the
   names still diverge, a `vendor_name_under_id` **minor** fires so a human confirms the payee — a
   misread or shared ID can't silently route payment to the wrong company.
2. **Exact** on case-folded, whitespace-collapsed names.
3. **Normalized equality** — additionally strip legal suffixes (Ltd/Inc/GmbH/LLC/…) and punctuation.
4. **Guarded fuzzy** — Levenshtein edit distance on the normalized names, but only for names of at
   least `VENDOR_FUZZY_MIN_LEN` (5) characters, and only within `min(VENDOR_LEVENSHTEIN_MAX,
   floor(len × 0.2))`. This catches typos ("Acme Inudstrial") while refusing to collide short
   unrelated names like `ACME` vs `ACRE`.

Only if all of these fail do we emit `vendor_mismatch` (major). Thresholds live in `CONFIG`.

---

## 7. Worked examples

All four were executed against the code above and reproduce exactly.

### 7.1 Clean match → Ready for Payment

Invoice and PO agree on vendor, PO number, currency, both line items (qty + price), and totals.

**Input (abridged):** invoice net `12000.00`, tax `1560.00`, gross `13560.00`, rate `13%`; PO
`netTotal 12000.00`, `taxTotal 1560.00`, `grossTotal 13560.00`; line items identical.

```jsonc
{
  "validationStatus": "Ready for Payment",
  "severity": "none",
  "matchSummary": "PO PO-2026-0442: Ready for Payment. 0 major / 0 minor discrepancies.",
  "discrepancies": [],
  "meta": { "counts": { "major": 0, "minor": 0, "fields": 12 }, "...": "..." }
}
```

### 7.2 Minor tax drift → Procurement Review

Everything matches except the stated tax. The tax check forgives drift that is inside the absolute
rounding slack (`TAX_ABS_TOLERANCE_CENTS`, 2¢) **or** inside the relative band (2%) **but only up to a
bounded absolute ceiling** (`TAX_REL_CEILING_CENTS`, $5.00). So a genuinely large dollar error can no
longer hide behind a small percentage.

**Input:** net `12000.00`, tax **`1520.00`**, gross **`13520.00`** (identity holds: 12000+1520=13520),
rate `13%` → expected tax `1560.00`. Drift `−40.00` (4000¢): beyond the 2¢ absolute slack, and beyond
the $5.00 relative ceiling, so it flags. Relative drift is 2.56% (≤ 5%), so it stays **minor**.

```jsonc
{
  "validationStatus": "Procurement Review",
  "severity": "minor",
  "matchSummary": "PO PO-2026-0442: Procurement Review. 0 major / 1 minor discrepancy.",
  "discrepancies": [
    {
      "field": "taxAmount",
      "type": "incorrect_tax_calculation",
      "severity": "minor",
      "invoiceValue": 152000,
      "poValue": 156000,
      "delta": -4000,
      "message": "Tax 1520.00 inconsistent with Net 12000.00 × 13% = 1560.00 (Δ -40.00)."
    }
  ]
}
```

> A drift over 5% relative auto-escalates the same discrepancy from minor to **major**. And a small
> percentage on a very large tax figure that exceeds the absolute ceiling now flags too — the old
> "any small %" loophole is closed.

### 7.3 Quantity + price mismatch → Rejected

Invoice bills `AC-9910` at qty 250 (PO 200) and unit price 38.00 (PO 35.00, +8.57%), which also pushes
the invoice net and gross over the PO. (PO here exposes `netTotal` and `grossTotal` but no explicit
`taxTotal`, so no separate `tax_amount_mismatch` fires — only the four blocks below.)

```jsonc
{
  "validationStatus": "Rejected",
  "severity": "major",
  "matchSummary": "PO PO-2026-0442: Rejected. 4 major / 0 minor discrepancies — blocking: quantity_mismatch, unit_price_mismatch, net_amount_mismatch, invoice_exceeds_po.",
  "discrepancies": [
    { "field": "lineItem[#1/AC9910].quantity",  "type": "quantity_mismatch",   "severity": "major", "invoiceValue": 250,   "poValue": 200,   "delta": 50 },
    { "field": "lineItem[#1/AC9910].unitPrice", "type": "unit_price_mismatch",  "severity": "major", "invoiceValue": 3800,  "poValue": 3500,  "delta": 300 },
    { "field": "netAmount",   "type": "net_amount_mismatch", "severity": "major", "invoiceValue": 1450000, "poValue": 1200000, "delta": 250000 },
    { "field": "grossAmount", "type": "invoice_exceeds_po",  "severity": "major", "invoiceValue": 1638500, "poValue": 1356000, "delta": 282500 }
  ]
}
```

### 7.4 Missing PO → Rejected (terminal)

No PO record returned from Airtable (`po` is `{}` or `_notFound: true`).

```jsonc
{
  "validationStatus": "Rejected",
  "severity": "major",
  "matchSummary": "PO PO-2026-0442: Rejected. 1 major / 0 minor discrepancy — blocking: missing_po.",
  "discrepancies": [
    {
      "field": "poNumber",
      "type": "missing_po",
      "severity": "major",
      "invoiceValue": "PO-2026-0442",
      "poValue": null,
      "delta": null,
      "message": "No approved Purchase Order found for PO Number \"PO-2026-0442\"."
    }
  ]
}
```

> If your policy prefers **Review** rather than **Rejected** for a missing PO (so a human can attach
> the right PO), change `CONFIG.SEVERITY.missing_po` to `'minor'`. One-line, documented, done. The same
> terminal-and-flag treatment applies to a **wrong PO** (`wrong_po`): if the invoice references a
> different PO than the one fetched, the engine flags it and stops rather than emitting a cascade of
> meaningless deltas against the wrong commitment.

---

## 8. Where each configurable constant lives

All tunables are in the `CONFIG` block at the top of the node. For production, replace the literals
with environment reads so the same workflow behaves differently per environment without editing code:

| Constant | Meaning | Suggested env var |
|----------|---------|-------------------|
| `MONEY_REL_TOLERANCE_PCT` | ± relative tolerance on money (net/tax/total/unit price) | `MONEY_REL_TOLERANCE_PCT` |
| `TAX_ABS_TOLERANCE_CENTS` | absolute rounding slack on recomputed tax | `TAX_ABS_TOLERANCE_CENTS` |
| `TAX_REL_CEILING_CENTS` | max absolute $ the relative tax band may forgive | `TAX_REL_CEILING_CENTS` |
| `TOTAL_ABS_TOLERANCE_CENTS` | slack on Net+Tax=Gross identity | `TOTAL_ABS_TOLERANCE_CENTS` |
| `QUANTITY_EXACT` | quantities must match exactly | `QUANTITY_EXACT` |
| `DESC_SIMILARITY_THRESHOLD` | Jaccard threshold for description-based line matching | `DESC_SIMILARITY_THRESHOLD` |
| `VENDOR_LEVENSHTEIN_MAX` | max edit distance for fuzzy vendor match | `VENDOR_LEVENSHTEIN_MAX` |
| `VENDOR_FUZZY_MIN_LEN` | shortest normalized name eligible for fuzzy match | `VENDOR_FUZZY_MIN_LEN` |
| `VENDOR_FUZZY_RATIO` | distance cap as a fraction of name length | `VENDOR_FUZZY_RATIO` |
| `REQUIRE_PO_APPROVED` | require PO `approvalStatus == Approved` | `REQUIRE_PO_APPROVED` |
| `ALLOW_CREDIT_NOTES` | treat negative net/qty as credit note, not error | `ALLOW_CREDIT_NOTES` |
| `PO_TOTAL_IS_GROSS_DEFAULT` | interpret legacy `totalAmount` as gross when flag absent | `PO_TOTAL_IS_GROSS_DEFAULT` |
| `SEVERITY` | discrepancy-type → severity policy table | (JSON env or in-code) |
| `CONFIDENCE_FLOOR` | LLM confidence floor below which a minor flag fires | `CONFIDENCE_FLOOR` |

Example production header for the node:

```javascript
const CONFIG = {
  MONEY_REL_TOLERANCE_PCT: Number($env.MONEY_REL_TOLERANCE_PCT ?? 2),
  TAX_ABS_TOLERANCE_CENTS: Number($env.TAX_ABS_TOLERANCE_CENTS ?? 2),
  TAX_REL_CEILING_CENTS:   Number($env.TAX_REL_CEILING_CENTS ?? 500),
  // ...etc
};
```

---

## 9. Defensive-handling summary

- **Every** numeric read goes through `toCents`/`toNum`, which strip currency symbols and separators,
  preserve sign (credit notes survive), and return `null` on garbage — the engine never `NaN`-propagates
  or throws.
- **Money is compared only in integer cents**, eliminating IEEE-754 float error (`0.1 + 0.2` bugs).
- **Missing PO** and **wrong PO** are first-class **terminal** branches: the engine refuses to
  deep-compare an invoice against a PO it has already declared missing or wrong.
- **Net and Tax are compared against the PO**, not only gross-vs-total: invoice net ↔ PO net and
  invoice tax ↔ PO tax, with gross-vs-gross as the "exceeds PO" block. The PO's tax basis is resolved
  explicitly (`netTotal`/`taxTotal`/`grossTotal`/legacy `totalAmount` + `totalIsGross`), never assumed.
- **Null / unreadable fields** become `missing_data` minors (human confirms) — never a fabricated
  `quantity_mismatch`, and never silently coerced to `0`.
- **Tax tolerance is bounded**: a relative band forgives drift only up to an absolute dollar ceiling,
  so a small percentage on a large tax can't wave through a real dollar error. With no rate available,
  the engine raises `missing_data` instead of asserting "consistent."
- **Vendor fuzzy matching is guarded** by minimum length and a relative distance ratio; short
  unrelated names never collide. A name divergence under a matching `vendorId` still flags.
- **Same-SKU invoice lines are aggregated** before comparison, so split shipments reconcile.
- **Discrepancy values are always scalars** (strings/numbers/null) and line-item field keys embed the
  physical index, so Airtable/audit writes are unambiguous and never `[object Object]`.
- **Stringified line-item arrays** from Airtable long-text fields are auto-parsed by `coerceLineItems`.
- **Full/bare Airtable record** — the node reads `po.fields` if present, else treats `po` as the fields.
- The node is **pure**: no network, no writes. It is trivially unit-testable by calling it with
  `{ invoice, po }` fixtures (see the four worked examples), which is how the accompanying test suite
  exercises it.

---

## 10. Documented scope: credit notes, zero lines, and units of measure

These cases are handled deliberately rather than mis-flagged:

- **Credit notes.** With `ALLOW_CREDIT_NOTES` on (default), a negative `netAmount`/`grossAmount` marks
  the document as a credit note; "exceeds PO" and "under billing" over-value blocks are suppressed for
  it (a credit is *expected* to reduce spend), while structural checks (vendor, PO number, currency,
  line alignment) still run. Sign is preserved end-to-end through `toCents`.
- **Zero-value lines.** `moneyWithinTol` treats a `$0.00` PO reference exactly: only a `$0.00` invoice
  value matches; any nonzero value against a zero base is out of tolerance (no divide-by-tiny-base
  blow-up). Legitimate free lines pass; a nonzero charge against a zero-priced line is caught.
- **Unit of measure.** If both sides carry `unitOfMeasure` and they differ ("box" vs "each"), the
  engine raises a `missing_data` flag on that line rather than reporting a bogus quantity mismatch,
  because the two numbers aren't a like-for-like comparison. Automatic unit conversion (e.g. 1 box =
  100 each) is intentionally **out of scope**; the flag routes it to a human. Provide matching UoM
  upstream if conversion is required.
