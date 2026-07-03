# Sample Data — AI PO Matching & Invoice Validation

This file contains everything needed to **seed** the Airtable `Purchase_Orders` table and to **demo** the workflow end-to-end. Every number is internally consistent so you can trace an invoice line-by-line against its PO during the demo video and assert extraction/validation correctness.

**Conventions used throughout**
- All money is compared in **integer minor units (cents)** inside the n8n Code nodes. The human-readable tables below show decimal amounts; the seed JSON shows the same values.
- **Monetary tolerance:** `MONEY_REL_TOLERANCE_PCT = 2%` relative (net / tax / total / unit price).
- **Tax rounding tolerance:** `TAX_ABS_TOLERANCE_CENTS = 2` (2 cents absolute) on top of the % tolerance.
- **Exact-match fields:** PO Number, Currency (never tolerance-matched).
- **Quantity:** exact match by default.
- Default tax rate in the sample set is **13% (Ontario HST)** so tax math is easy to verify: `tax = round(net * 0.13, 2)`.

Discrepancy severity → outcome bands (Step 6) — mirrors the `SEVERITY` policy table in `docs/MATCHING_ENGINE.md`:
| Condition | Result |
|---|---|
| Amount within ±2% tolerance (net/tax/total/unit price) | **PASS** — no discrepancy (that's the point of tolerance-based validation) |
| Tax mis-computed: beyond 2¢ abs / $5 rel ceiling, ≤5% relative | `incorrect_tax_calculation` — MINOR |
| Missing line item (on PO, not invoiced — partial delivery) | MINOR |
| Under-billing (invoice below PO beyond tolerance) | MINOR |
| Unreadable/missing field (engine never fabricates a delta) | `missing_data` — MINOR |
| Missing PO / unknown PO number | MAJOR |
| Vendor mismatch | MAJOR |
| Quantity mismatch | MAJOR |
| Unit price outside ±2% | MAJOR |
| Net/tax/total beyond tolerance · invoice exceeds PO | MAJOR |
| Additional line item (billed but not on PO) | MAJOR |
| Duplicate invoice number | MAJOR (flag) |

Outcome: **0 discrepancies → Ready for Payment · only MINOR → Procurement Review · any MAJOR → Rejected.**

---

## 1. Vendor Set

| Vendor ID | Vendor Name | Currency | IBAN | Country |
|---|---|---|---|---|
| V-1001 | Northwind Office Supplies Ltd. | CAD | CA89 3704 0044 0532 0130 00 | Canada |
| V-1002 | Cascade Industrial Components Inc. | USD | US64 SVBK MXXX 1234 5678 90 | United States |
| V-1003 | Helvetia Precision Tools GmbH | EUR | DE89 3704 0044 0532 0130 00 | Germany |

---

## 2. Purchase Orders (seed the `Purchase_Orders` Airtable table)

### PO-2001 — Northwind Office Supplies Ltd. (CAD)

| SKU | Description | Qty | Unit Price | Line Total |
|---|---|---|---|---|
| NW-PAP-A4 | A4 Premium Paper, 80gsm (case of 5 reams) | 40 | 32.50 | 1,300.00 |
| NW-TNR-58A | Toner Cartridge 58A (black) | 12 | 95.00 | 1,140.00 |
| NW-PEN-BLK | Gel Pens, black (box of 50) | 20 | 18.00 | 360.00 |

- **Net:** 2,800.00 · **Tax (13%):** 364.00 · **Total:** 3,164.00 · **Currency:** CAD · **Approval Status:** Approved

### PO-2002 — Cascade Industrial Components Inc. (USD)

| SKU | Description | Qty | Unit Price | Line Total |
|---|---|---|---|---|
| CI-BRG-608 | Ball Bearing 608ZZ (pack of 100) | 50 | 42.00 | 2,100.00 |
| CI-BLT-M8 | Hex Bolt M8×40 (pack of 200) | 30 | 26.50 | 795.00 |

- **Net:** 2,895.00 · **Tax (0%, cross-border, no tax on this PO):** 0.00 · **Total:** 2,895.00 · **Currency:** USD · **Approval Status:** Approved

### PO-2003 — Helvetia Precision Tools GmbH (EUR)

| SKU | Description | Qty | Unit Price | Line Total |
|---|---|---|---|---|
| HP-CAL-150 | Digital Caliper 150mm | 15 | 78.00 | 1,170.00 |
| HP-MIC-25 | Micrometer 0–25mm | 10 | 132.00 | 1,320.00 |
| HP-GAU-SET | Feeler Gauge Set (32 blades) | 25 | 14.40 | 360.00 |

- **Net:** 2,850.00 · **Tax (19% DE VAT):** 541.50 · **Total:** 3,391.50 · **Currency:** EUR · **Approval Status:** Approved

### Seed JSON for `Purchase_Orders`

```json
[
  {
    "PO Number": "PO-2001",
    "Vendor Name": "Northwind Office Supplies Ltd.",
    "Vendor ID": "V-1001",
    "Currency": "CAD",
    "Approval Status": "Approved",
    "Net Amount": 2800.00,
    "Tax Amount": 364.00,
    "Total Amount": 3164.00,
    "Line Items": [
      { "sku": "NW-PAP-A4", "description": "A4 Premium Paper, 80gsm (case of 5 reams)", "quantity": 40, "unit_price": 32.50, "line_total": 1300.00 },
      { "sku": "NW-TNR-58A", "description": "Toner Cartridge 58A (black)", "quantity": 12, "unit_price": 95.00, "line_total": 1140.00 },
      { "sku": "NW-PEN-BLK", "description": "Gel Pens, black (box of 50)", "quantity": 20, "unit_price": 18.00, "line_total": 360.00 }
    ]
  },
  {
    "PO Number": "PO-2002",
    "Vendor Name": "Cascade Industrial Components Inc.",
    "Vendor ID": "V-1002",
    "Currency": "USD",
    "Approval Status": "Approved",
    "Net Amount": 2895.00,
    "Tax Amount": 0.00,
    "Total Amount": 2895.00,
    "Line Items": [
      { "sku": "CI-BRG-608", "description": "Ball Bearing 608ZZ (pack of 100)", "quantity": 50, "unit_price": 42.00, "line_total": 2100.00 },
      { "sku": "CI-BLT-M8", "description": "Hex Bolt M8x40 (pack of 200)", "quantity": 30, "unit_price": 26.50, "line_total": 795.00 }
    ]
  },
  {
    "PO Number": "PO-2003",
    "Vendor Name": "Helvetia Precision Tools GmbH",
    "Vendor ID": "V-1003",
    "Currency": "EUR",
    "Approval Status": "Approved",
    "Net Amount": 2850.00,
    "Tax Amount": 541.50,
    "Total Amount": 3391.50,
    "Line Items": [
      { "sku": "HP-CAL-150", "description": "Digital Caliper 150mm", "quantity": 15, "unit_price": 78.00, "line_total": 1170.00 },
      { "sku": "HP-MIC-25", "description": "Micrometer 0-25mm", "quantity": 10, "unit_price": 132.00, "line_total": 1320.00 },
      { "sku": "HP-GAU-SET", "description": "Feeler Gauge Set (32 blades)", "quantity": 25, "unit_price": 14.40, "line_total": 360.00 }
    ]
  }
]
```

> **Airtable note:** `Line Items` is stored as a JSON string in a Long-text field. If you prefer a linked/child table, split each `line_items` array into a `PO_Line_Items` table keyed by PO Number — the workflow reads whichever you configure via the `AIRTABLE_PO_TABLE` / `AIRTABLE_PO_LINES_TABLE` env vars.

---

## 3. Supplier Invoices (demo scenarios)

Each invoice below is provided as **clean invoice text ready to paste into a PDF** (see §5 for how to render). Each is labeled with its **expected outcome**, **expected extracted JSON**, and **expected discrepancy result**.

---

### Invoice A — PERFECT MATCH → **Ready for Payment**

Matches PO-2001 exactly.

```
NORTHWIND OFFICE SUPPLIES LTD.
120 Front Street West, Toronto, ON M5J 1E3, Canada
GST/HST Reg: 84712 3345 RT0001

INVOICE

Invoice Number:   INV-NW-4501
Invoice Date:     2026-06-18
Due Date:         2026-07-18
Purchase Order:   PO-2001
Bill To:          Automantics Procurement, 55 York St, Toronto, ON

------------------------------------------------------------------
SKU          Description                          Qty  Unit    Amount
------------------------------------------------------------------
NW-PAP-A4    A4 Premium Paper, 80gsm (case/5)      40  32.50   1,300.00
NW-TNR-58A   Toner Cartridge 58A (black)           12  95.00   1,140.00
NW-PEN-BLK   Gel Pens, black (box of 50)           20  18.00     360.00
------------------------------------------------------------------
                                       Net Amount:          2,800.00
                                       HST (13%):             364.00
                                       Gross Amount:        3,164.00

Currency: CAD
Remit to IBAN: CA89 3704 0044 0532 0130 00
Thank you for your business.
```

**Expected extracted JSON**
```json
{
  "vendor_name": "Northwind Office Supplies Ltd.",
  "vendor_id": null,
  "purchase_order_number": "PO-2001",
  "invoice_number": "INV-NW-4501",
  "invoice_date": "2026-06-18",
  "due_date": "2026-07-18",
  "currency": "CAD",
  "net_amount": 2800.00,
  "tax_amount": 364.00,
  "tax_rate": 13,
  "gross_amount": 3164.00,
  "line_items": [
    { "sku": "NW-PAP-A4", "description": "A4 Premium Paper, 80gsm (case/5)", "quantity": 40, "unit_price": 32.50, "line_total": 1300.00 },
    { "sku": "NW-TNR-58A", "description": "Toner Cartridge 58A (black)", "quantity": 12, "unit_price": 95.00, "line_total": 1140.00 },
    { "sku": "NW-PEN-BLK", "description": "Gel Pens, black (box of 50)", "quantity": 20, "unit_price": 18.00, "line_total": 360.00 }
  ],
  "confidence_score": 0.98,
  "extraction_warnings": []
}
```

**Expected discrepancy result:** `[]` (none). **Validation Status → Ready for Payment.**

---

### Invoice B — MINOR discrepancy → **Procurement Review**

Matches PO-2003 perfectly on lines and net — but the supplier **mis-computed the VAT line**: stated tax is **533.90** instead of `2,850.00 × 19% = 541.50` (Δ −7.60). The drift exceeds the recomputation slack (2¢ absolute / €5.00 relative ceiling) so it flags, but at 1.40% relative it stays **MINOR** → `incorrect_tax_calculation` → Procurement Review.

> **Why a tax slip and not a price nudge:** variances *within* the ±2% money tolerance pass **clean** — that is the point of tolerance-based validation. A unit price 1% off the PO is not a discrepancy at all; it's Ready for Payment. The canonical minor-severity triggers are tax-math drift, partial delivery (`missing_line_item`), under-billing, and unreadable fields (`missing_data`).

```
HELVETIA PRECISION TOOLS GMBH
Industriestrasse 12, 8005 Zürich, Switzerland
VAT: DE 811 234 567

RECHNUNG / INVOICE

Invoice Number:   HPT-2026-0342
Invoice Date:     2026-06-20
Due Date:         2026-07-20
Purchase Order:   PO-2003

------------------------------------------------------------------
SKU          Description                    Qty   Unit     Amount
------------------------------------------------------------------
HP-CAL-150   Digital Caliper 150mm           15   78.00    1,170.00
HP-MIC-25    Micrometer 0-25mm               10  132.00    1,320.00
HP-GAU-SET   Feeler Gauge Set (32 blades)    25   14.40      360.00
------------------------------------------------------------------
                                Net Amount:            2,850.00
                                VAT (19%):               533.90
                                Gross Amount:          3,383.90

Currency: EUR
Remit to IBAN: DE89 3704 0044 0532 0130 00
```

> Trace: lines & net identical to PO-2003. Stated VAT 533.90 vs recomputed 2,850.00 × 19% = 541.50 → Δ −7.60 (1.40%): beyond the 2¢/€5.00 recomputation slack ⇒ flags; ≤5% relative ⇒ stays MINOR. Tax vs PO tax field (541.50) differs by 1.40% ≤ 2% money tolerance ⇒ no `tax_amount_mismatch`. Net+Tax=Gross identity holds (2,850.00 + 533.90 = 3,383.90). Gross 3,383.90 vs PO 3,391.50 = −0.22%, within tolerance.

**Expected extracted JSON**
```json
{
  "vendor_name": "Helvetia Precision Tools GmbH",
  "vendor_id": null,
  "purchase_order_number": "PO-2003",
  "invoice_number": "HPT-2026-0342",
  "invoice_date": "2026-06-20",
  "due_date": "2026-07-20",
  "currency": "EUR",
  "net_amount": 2850.00,
  "tax_amount": 533.90,
  "gross_amount": 3383.90,
  "tax_rate": 19,
  "line_items": [
    { "sku": "HP-CAL-150", "description": "Digital Caliper 150mm", "quantity": 15, "unit_price": 78.00, "line_total": 1170.00 },
    { "sku": "HP-MIC-25", "description": "Micrometer 0-25mm", "quantity": 10, "unit_price": 132.00, "line_total": 1320.00 },
    { "sku": "HP-GAU-SET", "description": "Feeler Gauge Set (32 blades)", "quantity": 25, "unit_price": 14.40, "line_total": 360.00 }
  ],
  "confidence_score": 0.96,
  "extraction_warnings": []
}
```

**Expected discrepancy result** *(verified against the engine in `docs/MATCHING_ENGINE.md`)*
```json
[
  {
    "field": "taxAmount",
    "type": "incorrect_tax_calculation",
    "severity": "minor",
    "invoiceValue": 53390,
    "poValue": 54150,
    "delta": -760,
    "message": "Tax 533.90 inconsistent with Net 2850.00 × 19% = 541.50 (Δ -7.60)."
  }
]
```
**Validation Status → Procurement Review** (0 major / 1 minor).

---

### Invoice C — MAJOR discrepancy → **Rejected**

Matches PO-2002, but **quantity mismatch** (bearings 80 vs 50) **and unit price mismatch** (bolts 31.00 vs 26.50, +16.98%), and the **invoice total exceeds the PO value**.

```
CASCADE INDUSTRIAL COMPONENTS INC.
4400 Willow Rd, Portland, OR 97205, USA
EIN: 47-1234567

INVOICE

Invoice Number:   CIC-88231
Invoice Date:     2026-06-22
Due Date:         2026-07-22
Purchase Order:   PO-2002

------------------------------------------------------------------
SKU          Description                     Qty   Unit     Amount
------------------------------------------------------------------
CI-BRG-608   Ball Bearing 608ZZ (pack/100)    80   42.00    3,360.00
CI-BLT-M8    Hex Bolt M8x40 (pack of 200)     30   31.00      930.00
------------------------------------------------------------------
                                Net Amount:            4,290.00
                                Tax (0%):                  0.00
                                Gross Amount:          4,290.00

Currency: USD
Remit to IBAN: US64 SVBK MXXX 1234 5678 90
```

> Trace: bearings qty 80 vs PO 50 (MAJOR). Bolt unit 31.00 vs 26.50 = +16.98% (MAJOR). Total 4,290.00 vs PO 2,895.00 = +48.2% exceeds PO (MAJOR).

**Expected extracted JSON**
```json
{
  "vendor_name": "Cascade Industrial Components Inc.",
  "vendor_id": null,
  "purchase_order_number": "PO-2002",
  "invoice_number": "CIC-88231",
  "invoice_date": "2026-06-22",
  "due_date": "2026-07-22",
  "currency": "USD",
  "net_amount": 4290.00,
  "tax_amount": 0.00,
  "tax_rate": 0,
  "gross_amount": 4290.00,
  "line_items": [
    { "sku": "CI-BRG-608", "description": "Ball Bearing 608ZZ (pack/100)", "quantity": 80, "unit_price": 42.00, "line_total": 3360.00 },
    { "sku": "CI-BLT-M8", "description": "Hex Bolt M8x40 (pack of 200)", "quantity": 30, "unit_price": 31.00, "line_total": 930.00 }
  ],
  "confidence_score": 0.97,
  "extraction_warnings": []
}
```

**Expected discrepancy result**
```json
[
  { "type": "QUANTITY_MISMATCH", "severity": "MAJOR", "sku": "CI-BRG-608", "po_value": 50, "invoice_value": 80 },
  { "type": "UNIT_PRICE_MISMATCH", "severity": "MAJOR", "sku": "CI-BLT-M8", "po_value": 26.50, "invoice_value": 31.00, "variance_pct": 16.98 },
  { "type": "INVOICE_TOTAL_EXCEEDS_PO", "severity": "MAJOR", "po_value": 2895.00, "invoice_value": 4290.00, "variance_pct": 48.19 }
]
```
**Validation Status → Rejected.**

---

### Invoice D — UNKNOWN PO number → **Rejected** (routed to Review if `TREAT_MISSING_PO_AS_REVIEW=true`)

Well-formed invoice, but references **PO-9999**, which does not exist in `Purchase_Orders`.

```
NORTHWIND OFFICE SUPPLIES LTD.
120 Front Street West, Toronto, ON M5J 1E3, Canada
GST/HST Reg: 84712 3345 RT0001

INVOICE

Invoice Number:   INV-NW-4599
Invoice Date:     2026-06-25
Due Date:         2026-07-25
Purchase Order:   PO-9999

------------------------------------------------------------------
SKU          Description                          Qty  Unit    Amount
------------------------------------------------------------------
NW-PAP-A4    A4 Premium Paper, 80gsm (case/5)      10  32.50     325.00
------------------------------------------------------------------
                                       Net Amount:            325.00
                                       HST (13%):              42.25
                                       Gross Amount:          367.25

Currency: CAD
Remit to IBAN: CA89 3704 0044 0532 0130 00
```

**Expected extracted JSON**
```json
{
  "vendor_name": "Northwind Office Supplies Ltd.",
  "vendor_id": null,
  "purchase_order_number": "PO-9999",
  "invoice_number": "INV-NW-4599",
  "invoice_date": "2026-06-25",
  "due_date": "2026-07-25",
  "currency": "CAD",
  "net_amount": 325.00,
  "tax_amount": 42.25,
  "tax_rate": 13,
  "gross_amount": 367.25,
  "line_items": [
    { "sku": "NW-PAP-A4", "description": "A4 Premium Paper, 80gsm (case/5)", "quantity": 10, "unit_price": 32.50, "line_total": 325.00 }
  ],
  "confidence_score": 0.95,
  "extraction_warnings": []
}
```

**Expected discrepancy result**
```json
[
  { "type": "MISSING_PO", "severity": "MAJOR", "po_value": null, "invoice_value": "PO-9999", "note": "No matching PO found in Purchase_Orders" }
]
```
**Validation Status → Rejected** (or **Procurement Review** if the missing-PO override env var is enabled). PO Match status field → `No PO Found`.

---

### Invoice E — DUPLICATE invoice (bonus) → **flagged**

Identical `Invoice Number` to **Invoice A** (`INV-NW-4501`), same vendor. Process **Invoice A first**, then this one to demo duplicate detection.

```
NORTHWIND OFFICE SUPPLIES LTD.
120 Front Street West, Toronto, ON M5J 1E3, Canada

INVOICE

Invoice Number:   INV-NW-4501
Invoice Date:     2026-06-18
Due Date:         2026-07-18
Purchase Order:   PO-2001

------------------------------------------------------------------
SKU          Description                          Qty  Unit    Amount
------------------------------------------------------------------
NW-PAP-A4    A4 Premium Paper, 80gsm (case/5)      40  32.50   1,300.00
NW-TNR-58A   Toner Cartridge 58A (black)           12  95.00   1,140.00
NW-PEN-BLK   Gel Pens, black (box of 50)           20  18.00     360.00
------------------------------------------------------------------
                                       Net Amount:          2,800.00
                                       HST (13%):             364.00
                                       Gross Amount:        3,164.00

Currency: CAD
Remit to IBAN: CA89 3704 0044 0532 0130 00
```

**Expected behavior:** extraction succeeds identically to Invoice A, but the duplicate-check Code node queries `Invoices` for an existing record with the same `Invoice Number` + `Vendor Name` and finds one.

**Expected discrepancy result**
```json
[
  { "type": "DUPLICATE_INVOICE", "severity": "MAJOR", "invoice_value": "INV-NW-4501", "note": "Invoice number already processed (record recXXXX)" }
]
```
**Validation Status → Rejected** with `Discrepancy Summary` noting the duplicate; do **not** create a second payable record (or create it flagged, per `DUPLICATE_POLICY` env var). This demonstrates the bonus duplicate-detection requirement.

---

### Invoice F — MALFORMED / SCANNED case → **error-handling path**

Purpose: demonstrate resilience when extraction fails or confidence is low. **Two ways to produce it** (either works for the demo):

1. **Scanned / image-only PDF (no text layer):** open Invoice A's rendered PDF, take a screenshot of it, and re-insert that image as a full-page picture into a new blank PDF (or "Print to PDF" a photo of it). The PDF now has **no extractable text layer**. Without OCR the text-extraction node yields empty/garbage text.
2. **Truncated / garbled text:** paste the block below into a PDF — key fields are missing (no PO number, no currency, amounts don't add up).

```
N0RTHW1ND 0FF1CE SUPPL...  [smudged]
Inv#  INV-?? 45  Date: 2O26-O6-3O
P.O.:  ---------
A4 Paper ....... qty ??  @ 32,5O   13OO
Toner .......... 12       ?????
Net .... 28OO   Tax .... ###   Total .... ------
```

**Expected behavior**
- If using the **scanned** version and `OCR_ENABLED=false`: text extraction returns near-empty → workflow raises `EXTRACTION_FAILED`, routes to the error branch, writes an `Invoices` record with `Validation Status = Review` and `Extraction Warnings = ["No text layer found; scanned document — OCR required"]`, and (bonus) posts a Slack/Teams alert. If `OCR_ENABLED=true`, it runs OCR then continues normally.
- If using the **garbled text** version: the LLM returns low confidence and populates `extraction_warnings`.

**Expected extracted JSON (garbled version)**
```json
{
  "vendor_name": "Northwind Office Supplies Ltd.",
  "vendor_id": null,
  "purchase_order_number": null,
  "invoice_number": "INV-?? 45",
  "invoice_date": "2026-06-30",
  "due_date": null,
  "currency": null,
  "net_amount": 2800.00,
  "tax_amount": null,
  "gross_amount": null,
  "line_items": [
    { "sku": null, "description": "A4 Paper", "quantity": null, "unit_price": 32.50, "line_total": 1300.00 }
  ],
  "confidence_score": 0.34,
  "extraction_warnings": [
    "Purchase order number unreadable",
    "Currency not found",
    "Tax and gross amounts missing/illegible",
    "Line item quantities unreadable"
  ]
}
```

**Routing rule:** `confidence_score < CONFIDENCE_THRESHOLD (default 0.70)` OR `purchase_order_number == null` OR `currency == null` → **Procurement Review** with warnings surfaced; never auto-pay. This shows graceful degradation rather than a crash.

---

## 4. Expected Results Summary (assertion table)

| Invoice | Vendor | PO | Net | Tax | Gross | Key discrepancies | Expected Status |
|---|---|---|---|---|---|---|---|
| A | Northwind | PO-2001 | 2,800.00 | 364.00 | 3,164.00 | none | **Ready for Payment** |
| B | Helvetia | PO-2003 | 2,850.00 | 533.90 | 3,383.90 | VAT mis-computed by −7.60 → `incorrect_tax_calculation` (MINOR) | **Procurement Review** |
| C | Cascade | PO-2002 | 4,290.00 | 0.00 | 4,290.00 | qty 80≠50, unit price +16.98%, total exceeds PO (MAJOR) | **Rejected** |
| D | Northwind | PO-9999 | 325.00 | 42.25 | 367.25 | missing/unknown PO (MAJOR) | **Rejected** / Review* |
| E | Northwind | PO-2001 | 2,800.00 | 364.00 | 3,164.00 | duplicate invoice number (MAJOR) | **Rejected / flagged** |
| F | Northwind | — | — | — | — | extraction failed / low confidence | **Procurement Review** (error path) |

\* depends on `TREAT_MISSING_PO_AS_REVIEW`.

---

## 5. How to turn invoice text into PDFs

Pick whichever is fastest for you.

**Option 1 — Print to PDF (no tooling).** Paste each invoice block into a monospace document (TextEdit in plain-text/monospace, VS Code, or a Google Doc with a monospace font like Courier), then **File → Print → Save as PDF**. Monospace preserves the column alignment. Name files `Invoice-A.pdf` … `Invoice-F.pdf`.

**Option 2 — One tiny script (recommended, repeatable).** Save each block as `invoice-A.txt`, etc., then convert. Using a headless tool:

```bash
# macOS: uses the built-in `cupsfilter` to make a PDF from text
for f in invoice-A invoice-B invoice-C invoice-D invoice-E; do
  cupsfilter "$f.txt" > "$f.pdf" 2>/dev/null
done
```

Or cross-platform with Node + puppeteer / `md-to-pdf`, or Python:

```bash
pip install fpdf2
python - <<'PY'
from fpdf import FPDF
import glob, os
for txt in glob.glob("invoice-*.txt"):
    pdf = FPDF(); pdf.add_page(); pdf.set_font("Courier", size=9)
    for line in open(txt, encoding="utf-8"):
        pdf.cell(0, 4, line.rstrip("\n"), ln=1)
    pdf.output(txt.replace(".txt", ".pdf"))
    print("wrote", txt.replace(".txt",".pdf"))
PY
```

**For the scanned case (Invoice F, option 1):** open `invoice-A.pdf`, screenshot the page, and place the screenshot as a full-page image in a new PDF (Preview: File → New from Clipboard → Export as PDF; or `img2pdf shot.png -o invoice-F-scanned.pdf`). Result has no text layer.

---

## 6. How to email invoices into the workflow

1. In n8n, the Step-1 trigger is an **email node** (Gmail/IMAP) watching the procurement inbox defined by `PROCUREMENT_INBOX` (e.g. `procurement@yourdomain`).
2. From any mailbox, send **one email per invoice** to that address:
   - **Subject:** something realistic, e.g. `Invoice INV-NW-4501 — PO-2001`.
   - **Attachment:** the corresponding `Invoice-X.pdf` (PDF only — the workflow ignores emails without a PDF attachment, which you can demo by also sending one plain email with no attachment).
   - **Body:** optional; the workflow reads Sender Name, Sender Email, Subject, and Received timestamp as metadata (Step 1).
3. Recommended demo order: **A → B → C → D → A-again-as-E (duplicate) → F**. This shows a clean pass, a review, a rejection, an unknown PO, a duplicate flag, and the error path — one of each evaluation scenario.
4. To demo the "ignore unsupported" rule, also send an email with a `.png` or `.docx` attachment and show the workflow skipping it.

> Tip for the video: keep the Airtable `Invoices` grid open beside n8n so each execution visibly creates/updates a row with the extracted data, PO match status, discrepancy summary, and validation status — then flip to Procurement Review to override Invoice B and approve it (Step 8–9 audit trail).
