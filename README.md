# AI Purchase Order Matching & Invoice Validation

An end-to-end AI procurement workflow: supplier invoices arrive by **email**, are
**extracted with an LLM**, **validated against their approved Purchase Order by a
deterministic matching engine**, checked for **discrepancies**, and routed to
**Ready for Payment / Procurement Review / Rejected** — with a human in control of
exceptions and a complete **audit trail** of every state change.

---

## 1. The core design decision

**The LLM extracts *facts only*. Every pass/fail *decision* is deterministic JavaScript.**

- OpenAI (`gpt-4.1-nano`, temperature 0, **Structured Outputs** with `strict: true`)
  turns the invoice PDF into schema-guaranteed JSON — it is *impossible* for the
  model to return malformed or wrongly-keyed output.
- PO matching, discrepancy detection, and outcome banding (Steps 4–6 of the brief)
  run as a **pure, unit-tested JavaScript engine** in an n8n Code node
  ([workflows/code_nodes/matching_engine.js](workflows/code_nodes/matching_engine.js),
  **24 passing assertions** in [tests/engine.test.js](tests/engine.test.js)).
- Result: the same invoice always produces the same verdict, every decision is
  explainable field-by-field, and the business rules are testable without running
  n8n at all. No LLM in the payment-decision path.

## 2. How it maps to the 9 required steps

| # | Brief requirement | Implementation |
|---|---|---|
| 1 | Monitor procurement inbox, PDF-only, capture metadata | **Gmail Trigger** (poll, `has:attachment filename:pdf`) → `Email Metadata` Code node captures Sender Name, Sender Email, Subject, Received At; non-PDF mail routed to an explicit *Ignored* branch |
| 2 | Extract invoice data via AI → valid JSON | `Extract From File` (PDF text) → **OpenAI Chat Completions** with a strict JSON Schema covering vendor, vendor ID, PO number, invoice number, dates, currency, net/tax/gross, line items, confidence score, extraction warnings |
| 3 | Retrieve the Purchase Order | Airtable REST search on `Purchase_Orders` by PO Number (approved line items, quantities, unit prices, totals, currency, approval status) |
| 4 | Field-by-field PO matching | Deterministic engine compares vendor (exact → normalized → bounded-fuzzy), PO number, currency, line items (SKU-first alignment with description-similarity fallback), quantity, unit price, net, tax, total — all money in **integer cents**, emitting a structured `fieldComparisons` array |
| 5 | Discrepancy detection | Typed discrepancies: `missing_po`, `vendor_mismatch`, `quantity_mismatch`, `unit_price_mismatch`, `additional_line_item`, `missing_line_item`, `incorrect_tax_calculation`, `invoice_exceeds_po`, `line_total_mismatch`, `total_identity_mismatch`, `missing_data`, `low_confidence` … each with severity + human-readable message |
| 6 | Validation logic | **0 discrepancies → Ready for Payment · only minor → Procurement Review · any major → Rejected** (severity policy is a single configurable table in the engine) |
| 7 | Store the invoice | Airtable `Invoices` record: extracted data, PO reference, full field comparison (JSON), discrepancy report, validation status, **original PDF attached**, immutable raw AI output |
| 8 | Procurement review | The Airtable grid **is** the review UI: reviewers read the discrepancy summary, override status, set `Approval Decision = Approve/Reject`, add `Reviewer Comments` |
| 9 | Approval workflow + audit trail | **Flow B** applies the decision: status → Ready for Payment / Rejected, `Approval Timestamp`, `Approved By`, `Rejection Reason`, and appends to the append-only **`Audit_Log`** table (every ingestion, decision, and duplicate-skip is logged) |

**Safety property (beyond the brief):** an invoice with unreadable amounts, an
inconsistent line total (`qty × unit ≠ stated total`), or a missing confidence
score can **never** auto-approve — missing data always routes to human review.
This is enforced by the engine and covered by regression tests.

## 3. Architecture

```
                   ┌──────────────────────────────────────────────┐
  procurement      │  FLOW A — Ingest → Extract → Match → Store   │
  inbox  ─────────▶│  Gmail Trigger · 21 nodes                    │──┐
                   └──────────────────────────────────────────────┘  │ writes
                                                                     ▼
                                                          ┌────────────────────┐
                                                          │      Airtable      │
                                                          │ Purchase_Orders ·  │
                                                          │ Invoices ·         │
                                                          │ Audit_Log          │
                                                          └────────────────────┘
                   ┌──────────────────────────────────────────────┐  ▲
  reviewer sets    │  FLOW B — Approval / Status Updater          │  │ updates
  Approve/Reject ─▶│  Schedule Trigger · 6 nodes                  │──┘
                   └──────────────────────────────────────────────┘
```

**Flow A** (`workflows/flow_a_ingest_match.json`, 21 nodes):
Gmail Trigger → Email Metadata → *Has PDF?* → Extract PDF Text → *Has text layer?*
→ Build OpenAI Request → OpenAI Extract (retry ×3) → Parse Extraction →
**Check Duplicate** → *Is Duplicate?* → Find PO (retry ×3) → Prepare Match Input →
**Matching Engine** → Format Airtable Fields → Create Invoice Record → Upload PDF
Attachment → Audit Log Entry. Branches: no-PDF → Ignored; scanned/no-text → OCR
branch; duplicate → audit "duplicate skipped" (no second payable record).

**Flow B** (`workflows/flow_b_approval.json`, 6 nodes):
Schedule Trigger (1 min) → find records where `Approval Decision ∈ {Approve, Reject}`
and `Approval Timestamp` is blank → apply decision → PATCH the invoice → append
`Audit_Log` entry (actor, from-status → to-status, timestamp, comments).

Full node-by-node detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 4. Repository map

| Path | Contents |
|---|---|
| [workflows/flow_a_ingest_match.json](workflows/flow_a_ingest_match.json) | **Deliverable 1** — Flow A export (import into n8n) |
| [workflows/flow_b_approval.json](workflows/flow_b_approval.json) | **Deliverable 1** — Flow B export |
| [workflows/code_nodes/matching_engine.js](workflows/code_nodes/matching_engine.js) | The deterministic matching engine (exactly as embedded in Flow A) |
| [tests/engine.test.js](tests/engine.test.js) | **24 assertions** — run `node tests/engine.test.js` |
| [docs/SCHEMA.md](docs/SCHEMA.md) | **Deliverable 2** — database schema |
| [prompts/ai_prompts.md](prompts/ai_prompts.md) | **Deliverable 3** — AI prompts + design rationale |
| [sample-data/SAMPLE_DATA.md](sample-data/SAMPLE_DATA.md) · [sample-data/pdfs/](sample-data/pdfs/) | **Deliverable 4** — 3 seed POs + 6 test invoices (text + rendered PDFs) with expected outcomes |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Workflow topology, node configs, design decisions |
| [docs/MATCHING_ENGINE.md](docs/MATCHING_ENGINE.md) | Engine internals: contracts, tolerance tables, worked examples |
| [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md) | Failure matrix, retries, security, scalability |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | Scene-by-scene script for the demo video |
| [scripts/](scripts/) | `setup_airtable.py` (creates + seeds the base), `build_flow_a.py` / `build_flow_b.py` (workflow generators), `make_sample_pdfs.py` |
| [docker-compose.yml](docker-compose.yml) | Optional self-hosted n8n |

## 5. Setup instructions

### Prerequisites
- **n8n** — n8n Cloud (fastest) or self-hosted (`docker compose up -d`, UI at `localhost:5678`)
- **OpenAI API key** — https://platform.openai.com
- **Airtable** account + Personal Access Token — https://airtable.com/create/tokens
- A **Gmail** inbox to act as the procurement mailbox

### Step-by-step
1. **Airtable:** create an empty base, note its ID (`app…` in the URL). Create a PAT
   with scopes `data.records:read`, `data.records:write`, `schema.bases:read`
   (+ `schema.bases:write` for the one-time setup script only — remove after).
2. **Configure:** `cp .env.example .env`, fill in `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`.
   **Never commit `.env`** (it is gitignored).
3. **Create & seed tables:** `python3 scripts/setup_airtable.py` — creates
   `Purchase_Orders` (seeded with 3 sample POs), `Invoices`, `Audit_Log`. Idempotent.
4. **n8n credentials:** create three — Gmail OAuth2 (sign in with the procurement
   inbox), OpenAI (API key), Airtable Personal Access Token.
5. **Import workflows:** n8n → Workflows → Import from file →
   `workflows/flow_a_ingest_match.json`, then `workflows/flow_b_approval.json`.
   Assign credentials: Gmail Trigger → Gmail; OpenAI Extract → OpenAI; all
   Airtable HTTP nodes → Airtable PAT.
   > If your Airtable base ID differs, update it in the node URLs (or regenerate:
   > edit `BASE_ID` in `scripts/build_flow_a.py` / `build_flow_b.py` and re-run them).
6. **Test:** email a PDF from [sample-data/pdfs/](sample-data/pdfs/) to the inbox,
   wait ~15–20 s, click **Execute workflow** on Flow A, and watch the record appear
   in Airtable — matched, banded, PDF attached, audit-logged.
7. **Run the tests:** `node tests/engine.test.js` → 24 passing.

### Required environment variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Extraction model (`gpt-4.1-nano`; bump to `gpt-4o-mini` if needed) |
| `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` | Airtable PAT + target base |
| `AIRTABLE_PO_TABLE`, `AIRTABLE_INVOICES_TABLE`, `AIRTABLE_AUDIT_TABLE` | Table names (defaults match the setup script) |
| `PROCUREMENT_INBOX` | The monitored mailbox |
| `MONEY_REL_TOLERANCE_PCT` (2) | ± % tolerance on net / tax / total / unit price |
| `TAX_ABS_TOLERANCE_CENTS` (2) · `TAX_REL_CEILING_CENTS` (500) | Tax recomputation slack: absolute rounding OR relative band capped at an absolute ceiling |
| `TOTAL_ABS_TOLERANCE_CENTS` (2) | Slack on the Net + Tax = Gross identity |
| `TREAT_MISSING_PO_AS_REVIEW`, `DUPLICATE_POLICY`, `OCR_ENABLED` | Behavior flags |

In n8n Cloud, API keys live in **encrypted n8n credentials**; the tolerance values
are also present as literals in the engine `CONFIG` block (single place, documented).

## 6. Database schema (implemented)

Three tables (full field-by-field detail in [docs/SCHEMA.md](docs/SCHEMA.md), which
also documents an optional relational line-items upgrade):

- **`Purchase_Orders`** — PO Number (primary), Vendor Name/ID, Currency, Net/Tax/Total,
  Expected Tax Rate Pct, Approval Status, **Line Items JSON** (sku, description,
  quantity, unit_price, line_total).
- **`Invoices`** — every field the brief requires: Vendor Name, Vendor ID, PO Number,
  Invoice Number (primary), Invoice/Due Date, Currency, Net/Tax/Gross, Line Items JSON,
  **Purchase Order Match** (Matched/Partial/No Match), **Discrepancy Summary**,
  Discrepancy Severity, **Confidence Score**, **Validation Status**
  (Ready for Payment / Procurement Review / Rejected), **Reviewer Comments**,
  Approval Decision/Timestamp/Approved By/Rejection Reason, **Invoice Attachment**
  (original PDF), **Sender Email**, **Email Subject**, **Received At**, Processing
  Errors, Raw AI JSON, Last Updated (native).
- **`Audit_Log`** — append-only: Entry, Invoice Number, Action, Actor, From Status,
  To Status, Timestamp, Note. Every ingestion, approval, rejection, and
  duplicate-skip lands here; Airtable's native revision history is a second layer.

## 7. AI prompts

Two prompts, documented with rationale in [prompts/ai_prompts.md](prompts/ai_prompts.md):

1. **Invoice Extraction** (required) — facts only; nulls over guesses (ambiguous
   dates are *not* guessed — null + warning); numbers as numbers; ISO dates;
   ISO-4217 currency; per-run confidence score; enforced end-to-end by OpenAI
   **Structured Outputs** (`json_schema`, `strict: true`) so schema-valid JSON is
   guaranteed, not hoped for.
2. **Discrepancy Summary** (optional) — explains the deterministic engine's verdict
   in plain English for reviewers. It never decides pass/fail.

## 8. Assumptions

- Invoices arrive as **digital PDFs**; scanned/no-text-layer PDFs are detected
  (<30 chars extracted) and routed to a dedicated branch (OCR is a documented
  extension, `OCR_ENABLED` flag reserved).
- A `Purchase_Orders` table exists (per the brief); the setup script seeds it.
- **Tolerances:** PO number & currency exact; money ±2 % (configurable); quantity
  exact by default; tax recomputation allows 2¢ absolute or ≤2 % relative capped
  at $5. Within-tolerance variance **passes** (that is the point of
  tolerance-based validation); the canonical *minor* cases are tax-calculation
  drift, partial delivery, under-billing, unreadable fields, low confidence.
- Outcome bands per the brief's suggested logic (any major → Rejected). An
  alternative "missing PO → Review" policy is available via `TREAT_MISSING_PO_AS_REVIEW`.
- One currency per invoice/PO pair; cross-currency invoices are a `currency_mismatch` (major).

## 9. Error handling & resilience

- **Fail-soft:** no invoice is silently dropped — no-PDF mail is explicitly ignored
  (logged path), scanned PDFs branch for OCR/review, duplicates are audit-logged
  and skipped, attachment-upload failure does not kill the record write.
- **Never auto-pay on missing data:** unreadable net/gross, broken line arithmetic,
  or absent confidence score always produce discrepancies → human review.
- **Retries:** all external calls (OpenAI, Airtable) run with `Retry On Fail` ×3 +
  2 s backoff for 429/5xx blips.
- **Duplicate detection (bonus):** invoice number checked against existing records
  *before* creating — re-processing the same email cannot create a second payable.
- Full failure matrix: [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).

## 10. Security

- **No secrets in the repo** — keys live in n8n encrypted credentials / gitignored
  `.env`; `.env.example` ships placeholders only.
- **Least-privilege Airtable PAT** — runtime needs only `data.records:read/write` +
  `schema.bases:read`; the `schema.bases:write` scope is needed once by the setup
  script and can be removed after.
- Invoice PII stays inside Gmail → n8n → Airtable; nothing is sent anywhere else
  except the invoice text to the OpenAI API for extraction.

## 11. Scalability

- Flow A is stateless per-email → parallelizable; n8n queue mode + Gmail label-based
  triage for hundreds of invoices/day.
- Cost: ~1–2K tokens per invoice on `gpt-4.1-nano` ≈ **$0.0003/invoice**.
- Idempotency: duplicate check + Gmail `messageId` retained as an idempotency key;
  Flow B only touches records with a decision and no timestamp (safe to re-run).

## 12. Bonus features implemented

- [x] **Tolerance-based validation** — ±2 % money tolerance, integer-cents math, configurable
- [x] **Duplicate invoice detection** — pre-insert check + "duplicate skipped" audit entry
- [x] **Unit tests** — 24 assertions covering all demo scenarios + adversarial edge cases
- [x] **Retry & failure handling** — retry ×3 with backoff on every external call; fail-soft branches
- [x] **Comprehensive logging** — append-only `Audit_Log` for every action (ingest, approve, reject, duplicate)
- [ ] Three-way matching (GRN) / OCR / Slack notifications / multi-currency conversion — documented as extensions in [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md)

## 13. Deliverables checklist (per the brief)

| Deliverable | Where |
|---|---|
| 1. Exported workflow(s) JSON | [workflows/](workflows/) — Flow A + Flow B |
| 2. Database schema | [docs/SCHEMA.md](docs/SCHEMA.md) + §6 above |
| 3. AI prompts | [prompts/ai_prompts.md](prompts/ai_prompts.md) |
| 4. Sample POs & invoices | [sample-data/](sample-data/) — 3 POs, 6 invoices + PDFs, expected outcomes |
| 5. README (setup, env vars, workflow explanation, assumptions) | this file |
| 6. 5–10 min demo video | *(link added at submission — script in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md))* |

## 14. Verified test results

The four demo invoices produce exactly these outcomes (verified live in n8n **and**
by the offline test suite):

| Invoice | Scenario | Engine verdict |
|---|---|---|
| `invoice_A` (INV-NW-4501) | Perfect match vs PO-2001 | **Ready for Payment** — 0 discrepancies |
| `invoice_B` (HPT-2026-0342) | VAT mis-computed by −7.60 | **Procurement Review** — 1 minor (`incorrect_tax_calculation`) |
| `invoice_C` (CIC-88231) | Qty 80 vs 50, price +17 %, over PO | **Rejected** — 4 majors |
| `invoice_D` (INV-NW-4599) | References nonexistent PO-9999 | **Rejected** — `missing_po` |
| `invoice_A` re-sent | Duplicate | **Skipped** + audit entry, no second record |
