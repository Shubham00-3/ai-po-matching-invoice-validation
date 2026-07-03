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
    line_total_mismatch:        'major', // a line's stated total != qty × unit price
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

// ---- Line-level arithmetic: each line's total must equal quantity × unit price
// Catches manipulated/incoherent line totals even when qty & unit price look fine.
coerceLineItems(invoice.lineItems).forEach((li, i) => {
  const q = toNum(li && li.quantity);
  const up = toCents(li && li.unitPrice);
  const lt = toCents(li && li.lineTotal);
  if (q !== null && up !== null && lt !== null) {
    const expected = Math.round(q * up);
    const d = lt - expected;
    if (Math.abs(d) > CONFIG.TOTAL_ABS_TOLERANCE_CENTS) {
      pushCmp(`lineItem[#${i}].lineTotal`, centsToStr(lt), centsToStr(expected), false, 'line total != qty x unit');
      pushDisc(`lineItem[#${i}].lineTotal`, 'line_total_mismatch', lt, expected, d,
        `Line ${i}: stated total ${centsToStr(lt)} != qty ${q} x unit ${centsToStr(up)} ` +
        `= ${centsToStr(expected)} (Δ ${centsToStr(d)}).`);
    }
  }
});

// ============================================================================
// STEP 7 — MONETARY TOTALS (Net + Tax vs PO, gross-vs-gross, identity)
// ============================================================================
const invNet = toCents(invoice.netAmount);
const invTax = toCents(invoice.taxAmount);
const invGross = toCents(invoice.grossAmount);
const poT = resolvePoTotals(po);   // { netCents, grossCents, taxCents }

const isCreditNote = CONFIG.ALLOW_CREDIT_NOTES &&
  ((invNet !== null && invNet < 0) || (invGross !== null && invGross < 0));

// 7.0 REQUIRED-AMOUNT PRESENCE — an invoice with no readable net/total must NEVER
// auto-approve. Flag missing core amounts so it routes to human review, not payment.
if (invNet === null) {
  pushCmp('netAmount', null, centsToStr(poT.netCents), false, 'invoice net amount unreadable');
  pushDisc('netAmount', 'missing_data', null, poT.netCents, null,
    'Invoice net amount could not be read from the document; human confirmation required.');
}
if (invGross === null) {
  pushCmp('grossAmount', null, centsToStr(poT.grossCents), false, 'invoice gross/total unreadable');
  pushDisc('grossAmount', 'missing_data', null, poT.grossCents, null,
    'Invoice gross/total could not be read from the document; human confirmation required.');
}

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
  if (conf === null) {
    pushDisc('confidenceScore', 'low_confidence', null, CONFIG.CONFIDENCE_FLOOR, null,
      'Extraction did not report a confidence score; human verification advised.');
  } else if (conf < CONFIG.CONFIDENCE_FLOOR) {
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
