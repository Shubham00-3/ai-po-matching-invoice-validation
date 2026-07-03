# Database Schema — Airtable

**Base:** `Procurement`
**Tables:** `Purchase_Orders` (seeded / assumed to exist) · `PO_Line_Items` (child of PO) · `Invoices` (created by the workflow) · `Invoice_Line_Items` (child of Invoice) · `Audit_Log`

> The brief allows Airtable / Notion / NocoDB. We use **Airtable** for first-class
> **Attachment** fields (the original invoice PDF), an **editable grid** that doubles
> as the procurement-review UI (Step 8), native **per-record revision history** for
> the audit trail, and a clean, well-documented n8n integration (upsert + linked records).

---

## 1. Rationale — Airtable vs Notion / NocoDB, and the grid as review UI

| Requirement | Why Airtable wins |
|---|---|
| Original PDF stored on the record (Step 7) | First-class **Attachment** field; n8n uploads the binary directly. Notion needs file hosting; NocoDB attachment support is clunkier. |
| Procurement review UI (Step 8) | The **grid + record expand view IS the UI** — no app to build. A filtered *"Needs Review"* view (`Validation Status = Procurement Review`) gives reviewers a queue. They edit `Reviewer Comments`, set `Approval Decision`, done. |
| Override validation, approve/reject, comments (Steps 8–9) | Editable cells + single-selects + long-text, all inline. An **Airtable Automation or n8n poll** reacts to the `Approval Decision` change to finalize status and append to `Audit_Log`. |
| Audit trail (Step 9) | Native **per-cell revision history** (who/when/old→new) *plus* our explicit `Audit_Log` table *plus* immutable `Raw AI JSON`. Triple redundancy. |
| n8n integration | Mature Airtable node with **upsert**, linked-record, and attachment support; deterministic field names. |

**How the grid serves Step 8:** create a grid view **"Needs Review"** filtered to `Validation Status = Procurement Review`, sorted by `Received At`. Procurement opens a row, reads `Discrepancy Summary` + `Field Comparisons`, views the attached PDF, then sets `Approval Decision = Approve/Reject`, optionally overriding by editing `Validation Status` directly and adding `Reviewer Comments`. Two more views — **"Ready for Payment"** and **"Rejected"** — act as the downstream queues.

---

## 2. Table: `Purchase_Orders` (seeded / assumed pre-existing)

Header/parent fields. Line items are stored in a **linked child table `PO_Line_Items`** (chosen over a JSON blob — justified below).

| Field | Airtable type | Notes |
|---|---|---|
| PO Number | Single line text | **Primary field.** Business key, e.g. `PO-2026-0417`. Must be unique; matched EXACTLY against the invoice. |
| Vendor Name | Single line text | Approved supplier name. |
| Vendor ID | Single line text | Stable supplier code, e.g. `V-1032`. More reliable match key than name. |
| Currency | Single select | ISO-4217, e.g. `USD`, `CAD`, `EUR`. Matched EXACTLY. |
| PO Total Amount | Currency | Approved total (header). Compared with ±2% tolerance; also enforces "invoice total exceeds PO value". |
| PO Net Amount | Currency | Pre-tax approved total (optional but recommended for net-level matching). |
| PO Tax Amount | Currency | Approved tax (optional). |
| Approval Status | Single select | `Approved` / `Pending` / `Cancelled`. Workflow treats only `Approved` POs as valid to match against. |
| Line Items | Link to `PO_Line_Items` | One-to-many; the approved lines. |
| PO Date | Date | Issue date (optional context). |
| Buyer / Owner | Single line text | Procurement owner (optional). |
| Created At | Created time | Airtable native. |
| Last Updated | Last modified time | Airtable native. |

### Child table: `PO_Line_Items`

| Field | Airtable type | Notes |
|---|---|---|
| Line Key | Single line text | **Primary field.** e.g. `PO-2026-0417 · SKU-88`. |
| Purchase Order | Link to `Purchase_Orders` | Parent PO. |
| SKU / Item Code | Single line text | Match key for line-level comparison. |
| Description | Single line text | Human-readable item. |
| Quantity | Number (integer) | Approved qty. Matched EXACTLY by default. |
| Unit Price | Currency | Approved unit price. Compared in **integer minor units (cents)**, ±2%. |
| Line Total | Currency | `Quantity × Unit Price`. Compared ±2%. |

**Why a linked child table instead of a JSON long-text field:**
Line-level matching (Step 4/5: quantity mismatch, unit-price mismatch, missing/additional lines) is the heart of the task. A **relational child table** lets n8n fetch approved lines as clean records keyed by SKU, so the deterministic matcher joins invoice lines ↔ PO lines by SKU and compares field-by-field — auditable and human-readable in the grid. It also makes seeding sample POs trivial and lets reviewers eyeball approved lines directly.
*Trade-off acknowledged:* n8n must do a second fetch (or use a linked-record lookup) per PO. That's a fixed, cheap cost and worth it for correctness + UX. (A JSON long-text `Approved Line Items JSON` field is a valid single-table fallback and is included on `Invoices` for the *extracted* lines — see below — but for the **source of truth** we prefer the relational model.)

---

## 3. Table: `Invoices` (created by the workflow)

| Field | Airtable type | Source | Notes |
|---|---|---|---|
| Invoice Number | Single line text | Prompt (extract) | **Primary field.** Combined with Vendor for duplicate detection. |
| Vendor Name | Single line text | extract | |
| Vendor ID | Single line text | extract | |
| PO Number | Single line text | extract | Raw string as read from invoice (kept even if no PO match). |
| Purchase Order | Link to `Purchase_Orders` | workflow | Resolved link to the matched PO record; empty ⇒ **Missing PO** discrepancy. |
| Invoice Date | Date | extract | |
| Due Date | Date | extract | |
| Currency | Single select | extract | ISO-4217. Matched EXACTLY vs PO. |
| Net Amount | Currency | extract | Pre-tax. Compared in cents, ±2%. |
| Tax Amount | Currency | extract | Compared with small absolute rounding tolerance. |
| Gross Amount | Currency | extract | Total. Compared ±2%; drives "exceeds PO value". |
| Line Items | Link to `Invoice_Line_Items` | workflow | Extracted lines as child records (see below). |
| Line Items JSON | Long text | extract | Immutable raw extracted line array (JSON). Redundant, audit-friendly, single-fetch fallback. |
| Purchase Order Match | Single select | workflow (JS) | `Matched` / `Partial` / `No Match`. Header-level match verdict. |
| Field Comparisons | Long text (JSON) | workflow (JS) | Structured field-by-field result from Step 4 (see shape below). Machine-readable. |
| Discrepancy Summary | Long text | workflow (JS) | Human-readable bullet list of detected discrepancies (Step 5). |
| Discrepancy Severity | Single select | workflow (JS) | `None` / `Minor` / `Major`. The band that decides Validation Status. |
| Confidence Score | Number (decimal) | extract | 0–1 extraction confidence from the LLM. |
| Extraction Warnings | Long text | extract | LLM-flagged low-confidence fields. |
| Validation Status | Single select | workflow (JS) | `Ready for Payment` / `Procurement Review` / `Rejected`. Set deterministically; overridable by reviewer. |
| Reviewer Comments | Long text | human | Step 8. |
| Approval Decision | Single select | human | `Pending` / `Approve` / `Reject`. Reviewer action that triggers finalization. |
| Approval Timestamp | Date (with time) | workflow | Set when Approval Decision resolves (Step 9). |
| Approved By | Collaborator (or Single line text) | human/workflow | Actor on approval. Collaborator if reviewers are Airtable users; text if set via API. |
| Rejection Reason | Long text | human | Required when `Approval Decision = Reject`. |
| Assigned To | Collaborator (or Single line text) | workflow/human | Procurement reviewer for the "Needs Review" queue. |
| Invoice Attachment | Attachment | email | Original invoice PDF (Step 7). |
| Sender Email | Email | email | Step 1 metadata. |
| Sender Name | Single line text | email | Step 1 metadata. |
| Email Subject | Single line text | email | Step 1 metadata. |
| Received At | Date (with time) | email | Step 1 metadata. |
| Processing Errors | Long text | workflow | Populated by error branch; empty on success. Never drop an invoice. |
| Raw AI JSON | Long text | workflow | **Immutable** exact model output. Audit anchor. |
| Created At | Created time | Airtable | Automatic. |
| Last Updated | Last modified time | Airtable | Automatic (satisfies "Last Updated"). |

### Child table: `Invoice_Line_Items`

| Field | Airtable type | Notes |
|---|---|---|
| Line Key | Single line text | **Primary field.** e.g. `INV-5521 · SKU-88`. |
| Invoice | Link to `Invoices` | Parent invoice. |
| SKU / Item Code | Single line text | Join key to `PO_Line_Items`. |
| Description | Single line text | As extracted. |
| Quantity | Number (integer) | Extracted qty. |
| Unit Price | Currency | Extracted unit price. |
| Line Total | Currency | Extracted line total. |
| Line Match Result | Single select | `Match` / `Qty Mismatch` / `Price Mismatch` / `Not On PO` / `Missing From Invoice`. Per-line verdict from the JS matcher. |

> **On splitting lines into a child table:** it makes the line-level discrepancies (the graded core of Step 5) visible and reviewable in the grid, and lets the deterministic matcher write a per-line verdict. The parallel `Line Items JSON` field on the parent guarantees we always retain the raw extracted array even if child creation partially fails.

### Shape of `Field Comparisons` (JSON) — Step 4 output

```json
{
  "vendor":      { "invoice": "Acme Ltd",  "po": "Acme Ltd",  "match": true },
  "po_number":   { "invoice": "PO-2026-0417","po": "PO-2026-0417","match": true, "rule": "exact" },
  "currency":    { "invoice": "USD",        "po": "USD",       "match": true, "rule": "exact" },
  "net_amount":  { "invoice_cents": 100000, "po_cents": 100000,"match": true, "rule": "±2%" },
  "tax_amount":  { "invoice_cents": 13000,  "po_cents": 13000, "match": true, "rule": "±$0.02 abs" },
  "total_amount":{ "invoice_cents": 113000, "po_cents": 113000,"match": true, "rule": "±2%" },
  "lines":       [ { "sku": "SKU-88", "qty_match": true, "price_match": true, "result": "Match" } ],
  "overall": "Matched"
}
```

---

## 4. Table: `Audit_Log`

Append-only. One row per state transition (created, validated, assigned, overridden, approved, rejected). Written by n8n and/or an Airtable Automation.

| Field | Airtable type | Notes |
|---|---|---|
| Event ID | Autonumber | **Primary field.** |
| Invoice | Link to `Invoices` | The invoice this event concerns. |
| Invoice Number | Single line text | Denormalized copy so log stays readable if a link is deleted. |
| Action | Single select | `Ingested` / `Extracted` / `Validated` / `Assigned` / `Override` / `Approved` / `Rejected` / `Error`. |
| Actor | Single line text | `system:n8n`, `openai`, or reviewer email/name. |
| From Status | Single select | Prior `Validation Status` (or empty on create). |
| To Status | Single select | New `Validation Status`. |
| Note | Long text | Reason / comment / error detail. |
| Timestamp | Created time | Airtable native — immutable, server-side. |

> **Why a separate log** on top of Airtable's revision history: revision history is per-field and not exportable/queryable via API in a clean, auditable stream. `Audit_Log` gives a single queryable, filterable, exportable trail — exactly what a procurement audit needs — while revision history remains as a tamper-evident backstop.

---

## 5. All single-select options to pre-create

| Field (table) | Options |
|---|---|
| `Purchase_Orders.Currency`, `Invoices.Currency` | `USD`, `CAD`, `EUR`, `GBP` *(extend as needed; unmatched values fall to Processing Errors)* |
| `Purchase_Orders.Approval Status` | `Approved`, `Pending`, `Cancelled` |
| `Invoices.Purchase Order Match` | `Matched`, `Partial`, `No Match` |
| `Invoices.Discrepancy Severity` | `None`, `Minor`, `Major` |
| `Invoices.Validation Status` | `Ready for Payment`, `Procurement Review`, `Rejected` |
| `Invoices.Approval Decision` | `Pending`, `Approve`, `Reject` |
| `Invoice_Line_Items.Line Match Result` | `Match`, `Qty Mismatch`, `Price Mismatch`, `Not On PO`, `Missing From Invoice` |
| `Audit_Log.Action` | `Ingested`, `Extracted`, `Validated`, `Assigned`, `Override`, `Approved`, `Rejected`, `Error` |
| `Audit_Log.From Status` / `To Status` | `Ready for Payment`, `Procurement Review`, `Rejected` *(+ empty allowed)* |

> **Single-select gotcha for n8n:** the Airtable API rejects unknown single-select options unless the field allows auto-create. **Pre-create every option above** before running the workflow. Currency values that arrive outside this list should be caught in the Code node and written to `Processing Errors` rather than blindly pushed to Airtable.

---

## Audit trail — summary (satisfies Step 9)

- **`Audit_Log`** — explicit, queryable, append-only stream of every transition.
- **Airtable revision history** — native per-field who/when/old→new backstop.
- **`Raw AI JSON`** + **`Line Items JSON`** — immutable record of exactly what the model returned, so any validation outcome is reproducible and reviewable.
- **`Created At` / `Last Updated`** — native lifecycle timestamps; `Approval Timestamp` / `Rejection Reason` capture the final human decision.
