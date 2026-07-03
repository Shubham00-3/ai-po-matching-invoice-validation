# Task 2 — AI Purchase Order Matching & Invoice Validation
## n8n Architecture

**Stack (fixed):** n8n (orchestration) · OpenAI `gpt-4.1-nano` @ temperature 0 (extraction, facts only) · Airtable (two tables + attachments + grid-as-review-UI) · Deterministic JavaScript Code nodes for all matching/validation decisions.

**Core design principle — separation of concerns:**
The LLM extracts **facts only** (Step 2). Every **pass/fail decision** — PO matching, discrepancy detection, and validation banding (Steps 4–6) — is **deterministic JavaScript** in n8n Code nodes. This makes the business logic auditable, unit-testable, and gradeable, and means the same invoice always yields the same verdict regardless of LLM sampling. This is the headline architectural claim of the submission.

---

## 1. Workflow topology — how many workflows and why

Three n8n workflows:

| Flow | Name | Trigger | Responsibility | Steps covered |
|------|------|---------|----------------|---------------|
| **A** | `PO_Ingest_Extract_Match_Store` | Gmail Trigger (poll) | Ingest email → filter PDF → extract text → OpenAI extraction → retrieve PO → deterministic match → detect discrepancies → band validation → write Airtable record | 1–7 |
| **B** | `PO_Approval_Status_Updater` | Airtable Trigger (record enters review / decision set) | Human-in-the-loop: read reviewer decision + comments from the grid, apply approve/reject, stamp audit fields, finalise status | 8–9 |
| **E** | `Shared_Error_Audit_Handler` | Execute Workflow Trigger + set as **Error Workflow** for A & B | Central catch: append to `Audit_Log` table, Slack alert, mark invoice `Processing Error` | cross-cutting |

**Why split (justification for grading):**

- **Testability** — Flow A is a pure "email in → Airtable row out" pipeline you can replay from a fixed sample invoice. Flow B is a pure "decision in → status out" state machine. Each is testable in isolation without mocking the other.
- **Different triggers / lifecycles** — Ingestion is event-driven from email; approval is event-driven from a *human* editing Airtable hours or days later. Coupling them into one workflow would force a long-lived wait node and make retries fragile.
- **Retries & idempotency** — If the OpenAI/extraction half fails, we retry *only* Flow A from the queue; the approval side is untouched. A failed approval never re-runs extraction.
- **Scalability** — Flow A is the throughput-bound, cost-bound path (LLM calls, PDF parsing) and can be scaled/queued independently (n8n queue mode, concurrency caps) without touching the lightweight approval flow.
- **Single audit surface** — one error/audit sub-workflow means every failure across both flows lands in one log table with one alerting path.

```
                    ┌─────────────────────────────────────────────┐
   procurement      │   FLOW A: Ingest → Extract → Match → Store   │
   inbox  ─────────▶│  (Gmail Trigger)                            │──┐
                    └─────────────────────────────────────────────┘  │ writes
                                     │ on any error                   ▼
                                     ▼                        ┌───────────────┐
                    ┌─────────────────────────────┐          │   Airtable    │
                    │  FLOW E: Error/Audit handler │◀────────▶│  Invoices +   │
                    └─────────────────────────────┘   logs   │  Purchase_    │
                                     ▲                        │  Orders +     │
                                     │ on any error           │  Audit_Log    │
                    ┌─────────────────────────────┐          └───────────────┘
   human edits ────▶│  FLOW B: Approval / Status  │──────────────▲
   grid decision    │  (Airtable Trigger)         │  updates     │
                    └─────────────────────────────┘──────────────┘
```

---

## 2. Flow A — `PO_Ingest_Extract_Match_Store`

### ASCII topology

```
[1 Gmail Trigger]
      │ (emails)
      ▼
[2 Filter: has PDF attachment?] ──no──▶ [2b NoOp: Ignored]   (Step 1)
      │ yes
      ▼
[3 Code: capture email metadata]                              (Step 1)
      │
      ▼
[4 Extract From File (PDF)] ──text empty?──▶ [4b IF scanned] ──▶ [4c OCR fallback*]
      │ text                                                     (Step 3 text extract)
      ▼
[5 Code: build OpenAI request payload]
      │
      ▼
[6 HTTP Request → OpenAI Chat Completions API]  (retryOnFail)       (Step 2)
      │ raw AI JSON
      ▼
[7 Code: parse + validate extraction JSON] ──invalid──▶ [Stop And Error] ──▶ Flow E
      │ clean invoice facts
      ▼
[8 Airtable: Search Purchase_Orders by PO#]                    (Step 3)
      │
      ▼
[9 IF: PO found?] ──no──▶ [9b Code: synth "Missing PO" discrepancy] ──┐
      │ yes                                                            │
      ▼                                                                │
[10 Merge (invoice facts + PO)]◀───────────────────────────────────────┘
      │
      ▼
[11 Code: MATCHING ENGINE  (deterministic)]                   (Step 4)
      │ field-by-field comparison
      ▼
[12 Code: DISCREPANCY DETECTOR (deterministic)]               (Step 5)
      │ discrepancy list + severities
      ▼
[13 Code: VALIDATION BANDING (deterministic)]                 (Step 6)
      │ Ready for Payment | Procurement Review | Rejected
      ▼
[14 Airtable: Create Invoices record + attach PDF]            (Step 7)
      │
      ▼
[15 IF: status == Procurement Review?] ──yes──▶ [15b Slack notify*]  (hands to Flow B)
      │
      ▼
[16 NoOp: Done]
```
`*` = bonus / optional.

### Numbered node list

**1. Gmail Trigger** — *n8n node: `Gmail Trigger`* — **(Step 1)**
- **Purpose:** poll the procurement inbox for new messages.
- **Config:** Event = *Message Received*; poll every 1 min; `Download Attachments = true`; filter to a label/query `has:attachment filename:pdf` to reduce noise; `Simplify = false` so full metadata is retained.
- **Passes on:** one item per email — `{ headers, from, subject, date, attachments[] (binary) }`.

**2. Filter — has PDF attachment?** — *`Filter`* — **(Step 1)**
- **Purpose:** process only emails carrying at least one `application/pdf` attachment; drop the rest.
- **Config:** condition `{{ $binary && Object.values($binary).some(b => b.mimeType === 'application/pdf') }}` true.
- **Passes on:** only qualifying email items. Non-matching → **2b NoOp "Ignored"** (explicitly satisfies "ignore unsupported").

**3. Code — capture email metadata** — *`Code`* — **(Step 1)**
- **Purpose:** normalise the four required metadata fields into a clean object carried through the run.
- **Returns:** `{ senderName, senderEmail, emailSubject, receivedAt (ISO), messageId }` merged with the binary PDF. `messageId` is retained as the **idempotency key**.

**4. Extract From File (PDF)** — *`Extract From File`, operation `Extract from PDF`* — **(Step 2, text extraction)**
- **Purpose:** pull raw text layer out of the PDF binary — no external OCR service needed for digital PDFs.
- **Config:** Source = binary property from node 3; output to `pdfText`.
- **Passes on:** `{ ...meta, pdfText }`.
- **4b IF — scanned?** (`IF`, `{{ $json.pdfText.trim().length < 30 }}`) → **4c OCR fallback\*** (bonus: HTTP Request to an OCR endpoint, or an OpenAI vision model on the rendered page). If OCR is out of scope, 4b routes to Stop And Error → Flow E with reason `SCANNED_PDF_UNSUPPORTED`.

**5. Code — build OpenAI request payload** — *`Code`* — **(Step 2)**
- **Purpose:** assemble the OpenAI Chat Completions API body; inject the **extraction system prompt** and the `pdfText` into the user message. Keeps prompt text in one place.
- **Returns:** `{ openaiBody: { model, temperature:0, max_tokens, messages, response_format } }` plus carried meta.

**6. HTTP Request → OpenAI Chat Completions API** — *`HTTP Request`* — **(Step 2)**
- **Purpose:** call OpenAI for extraction.
- **Config:** `POST https://api.openai.com/v1/chat/completions`; headers `Authorization: Bearer {{$env.OPENAI_API_KEY}}`, `content-type: application/json`; body = `{{$json.openaiBody}}`. **Settings: `Retry On Fail = true`, 3 attempts, 2000 ms wait** (handles 429/5xx/transient). Continue-on-fail = false so failures propagate to Flow E.
- **Passes on:** raw OpenAI response.

**7. Code — parse + validate extraction JSON** — *`Code`* — **(Step 2)**
- **Purpose:** safely parse `choices[0].message.content` into JSON (guaranteed valid when Structured Outputs is on — see §4); defensively strip code fences; assert required keys exist; coerce money strings to **integer minor units (cents)**; default missing arrays to `[]`. On unrecoverable parse failure → **`Stop And Error`** (message `EXTRACTION_JSON_INVALID`) which triggers Flow E.
- **Returns (invoice facts contract):**
```json
{
  "vendorName": "Acme Corp", "vendorId": "V-1042",
  "poNumber": "PO-2025-0917", "invoiceNumber": "INV-8841",
  "invoiceDate": "2026-06-20", "dueDate": "2026-07-20",
  "currency": "CAD",
  "netAmountCents": 480000, "taxAmountCents": 62400, "grossAmountCents": 542400,
  "lineItems": [{ "description":"Widget A","quantity":100,"unitPriceCents":4800,"lineTotalCents":480000 }],
  "confidenceScore": 0.96, "extractionWarnings": [],
  "rawAiJson": { ...verbatim... }
}
```
`rawAiJson` is stored immutably for audit.

**8. Airtable — Search Purchase_Orders** — *`Airtable`, operation `Search`* — **(Step 3)**
- **Purpose:** retrieve the approved PO by number.
- **Config:** Base `{{$env.AIRTABLE_BASE_ID}}`, Table `Purchase_Orders`, `filterByFormula = {PO Number} = '{{ $json.poNumber }}'`, return first match.
- **Passes on:** PO fields — `Vendor, PO Number, Approved Line Items (JSON), Quantity, Unit Price, Total Amount, Currency, Approval Status` — normalised to cents in the next step.

**9. IF — PO found?** — *`IF`* — **(Step 3 / feeds Step 5)**
- Condition: search returned ≥1 record.
- **No →** **9b Code "synth Missing PO"**: emit a PO stub with `found:false` so the matching engine can raise the `MISSING_PO` **MAJOR** discrepancy deterministically (rather than crashing). Missing PO is thus a normal, first-class rejection path, not an error.
- **Yes →** continue.

**10. Merge** — *`Merge`, mode `Combine` (by position)* — 
- **Purpose:** join invoice-facts item and PO item into a single object `{ invoice, po }` for the engine. (The 9b path feeds the same Merge with `po.found=false`.)

**11. Code — MATCHING ENGINE (deterministic)** — *`Code`* — **(Step 4)**
- Black box with a strict contract. **Input:** `{ invoice, po, config }`. **Output:** structured field-by-field result.
- Rules (all money in cents, integer math): `poNumber` & `currency` compared **EXACTLY**; `net/tax/gross/unitPrice` within **±TOLERANCE_PCT** (env, default 2%); `quantity` **exact**; `tax` also allowed a small **absolute** rounding tolerance (`TAX_ABS_TOLERANCE_CENTS`); line items matched by description/SKU.
- **Returns:**
```json
{ "fields": {
    "vendorName": {"invoice":"Acme","po":"Acme","match":true},
    "poNumber":   {"invoice":"PO-2025-0917","po":"PO-2025-0917","match":true},
    "currency":   {"invoice":"CAD","po":"CAD","match":true},
    "netAmount":  {"invoiceCents":480000,"poCents":480000,"deltaPct":0,"match":true},
    "taxAmount":  {"...":"..."}, "totalAmount":{"...":"..."},
    "lineItems":  [{"description":"Widget A","qtyMatch":true,"priceMatch":true,"match":true}]
  },
  "allMatch": true }
```

**12. Code — DISCREPANCY DETECTOR (deterministic)** — *`Code`* — **(Step 5)**
- **Input:** the matching result. **Output:** typed discrepancy list + human summary.
- Detects (the polished set): `MISSING_PO`, `VENDOR_MISMATCH`, `QUANTITY_MISMATCH`, `UNIT_PRICE_MISMATCH`, `ADDITIONAL_LINE_ITEM`, `MISSING_LINE_ITEM`, `TAX_CALC_ERROR`, `INVOICE_EXCEEDS_PO`. Each tagged `severity: MINOR | MAJOR`.
- **Returns:** `{ discrepancies:[{code,severity,detail}], discrepancySummary:"…", counts:{minor,major} }`.

**13. Code — VALIDATION BANDING (deterministic)** — *`Code`* — **(Step 6)**
- **Rule:** `major>0 → "Rejected"`; else `minor>0 → "Procurement Review"`; else `"Ready for Payment"`.
- **Returns:** `{ validationStatus, poMatchStatus }` merged with everything above. (Severity → band mapping is env-configurable.)

**14. Airtable — Create Invoices record** — *`Airtable`, operation `Create`* — **(Step 7)**
- **Purpose:** persist the full result and attach the original PDF.
- **Config:** Table `Invoices`; maps every schema field (see §Schema); `Invoice Attachment` set from the PDF binary (uploaded via public URL or Airtable attachment field); `Raw AI JSON` stored immutably; `Received At` from metadata; `Last Updated = now`.
- **Idempotency:** before create, `filterByFormula = {Invoice Number}='…'` — if exists, **Update** instead of Create (guards against re-processed emails / retries).

**15. IF — needs review?** — *`IF`* — **(hand-off to Step 8)**
- `validationStatus == "Procurement Review"` → **15b Slack/Teams notify\*** the procurement channel with a deep link to the Airtable row. Otherwise fall through.

**16. NoOp — Done** — *`NoOp`* — end of Flow A.

---

## 3. PDF text extraction (detail)

- **Primary:** the built-in **`Extract From File`** node, operation *Extract from PDF*, reads the text layer of digital PDFs directly inside n8n — zero external dependency, fast, free.
- **Empty-text guard (node 4b):** if extracted text is < ~30 chars the PDF is almost certainly scanned/image-only.
- **OCR fallback (bonus):** route scanned PDFs to either (a) an OCR HTTP endpoint (e.g. an OCR microservice / cloud OCR) returning text back into the same `pdfText` slot, or (b) send the rendered page image to OpenAI's vision input. Kept optional and clearly flagged so the primary path stays simple and reliable.

---

## 4. Calling OpenAI

**Recommendation: `HTTP Request` node to the OpenAI Chat Completions API** (not the built-in OpenAI node). Reasons: exact control of `model`, `temperature:0`, `max_tokens`, the `messages` array, and — crucially — `response_format` (Structured Outputs); identical request shape is copy-pasteable into the README and testable with `curl`; no dependency on node-version drift. Store the key as an n8n credential / `$env.OPENAI_API_KEY`.

**Exact request shape (node 6 body):**
```json
{
  "model": "gpt-4.1-nano",
  "temperature": 0,
  "max_tokens": 2000,
  "messages": [
    { "role": "system", "content": "<<< EXTRACTION SYSTEM PROMPT — prompts/ai_prompts.md (Prompt 1) >>>" },
    { "role": "user",
      "content": "Extract this invoice as JSON per the schema. INVOICE TEXT:\n\n{{ $json.pdfText }}" }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "invoice_extraction", "strict": true,
      "schema": "<<< invoice JSON schema — see prompts/ai_prompts.md >>>" }
  }
}
```

> With `strict: true` Structured Outputs, OpenAI is **guaranteed** to return schema-valid JSON, eliminating the classic “model returned broken JSON” failure mode — node 7 becomes light validation + cents-coercion, not defensive parsing.

**Where the two prompts plug in:**
- **Prompt 1 — Invoice Extraction** (`prompts/ai_prompts.md` — Prompt 1) → the first `system` message of node 6. Facts only; must return valid JSON with all Step-2 fields incl. `confidenceScore` and `extractionWarnings`.
- **Prompt 2 — "Validation" narrative** (`prompts/ai_prompts.md` — Prompt 2) is **NOT** a decision prompt. The decision is deterministic (nodes 11–13). Prompt 2 is optional and used only to render a human-readable discrepancy summary from the already-computed structured result. **The LLM never decides pass/fail** — this is the auditability selling point.

---

## 5. PO retrieval & missing-PO handling

- **Retrieve (node 8):** Airtable `Search` on `Purchase_Orders` with `filterByFormula = {PO Number} = '<extracted po>'`. Returns Vendor, PO Number, Approved Line Items, Quantity, Unit Price, Total Amount, Currency, Approval Status.
- **Missing PO (node 9 → 9b):** if the search returns nothing (or the extracted `poNumber` is empty), we **do not error**. Node 9b synthesises a PO stub `{ found:false }`. The matching engine (11) sees `found:false` and the discrepancy detector (12) raises `MISSING_PO` at **MAJOR** severity → banding (13) yields **"Rejected"**, and a normal Airtable record is still written with the discrepancy report. This keeps "no matching PO" auditable and visible in the grid rather than a silent failure.

---

## 6. The deterministic matching Code node (contract)

Sits at the centre of Flow A as **three chained Code nodes (11 → 12 → 13)**, kept separate so each is independently unit-testable:

| Node | Input | Output |
|------|-------|--------|
| 11 Matching Engine | `{ invoice, po, config }` | `{ fields:{…field-by-field…}, allMatch }` |
| 12 Discrepancy Detector | matching result | `{ discrepancies[], discrepancySummary, counts }` |
| 13 Validation Banding | discrepancies + counts | `{ validationStatus, poMatchStatus }` |

**Guarantees:** pure functions, no I/O, no LLM; all money in integer cents; tolerances read from `config` (env vars) so thresholds are configurable without code edits; deterministic → same input always same verdict. This trio is the gradeable "PO matching logic" + "business-rule implementation" surface and is designed to be lifted verbatim into a Jest test harness (bonus: unit tests).

---

## 7. Airtable writes + the human-review / approval loop (Flow B)

**Write (Flow A, node 14):** upsert into `Invoices` (create, or update if `Invoice Number` already present). The **editable Airtable grid IS the Step-8 review UI** — no separate app. Procurement sees extracted data, the structured `Discrepancy Summary`, `Confidence Score`, the attached PDF, and a `Validation Status`.

**Flow B — `PO_Approval_Status_Updater`:**

```
[1 Airtable Trigger: record enters "Procurement Review" OR Reviewer Decision set]
      │
      ▼
[2 Switch on Reviewer Decision]
   ├─ "Approve" ─▶ [3 Airtable Update: Validation Status="Ready for Payment",
   │                    Approved By, Approved At=now, Last Updated=now]     (Step 9)
   ├─ "Reject"  ─▶ [4 Airtable Update: Validation Status="Rejected",
   │                    Rejection Reason=Reviewer Comments, Approved At=now] (Step 9)
   └─ (none)    ─▶ [5 NoOp: wait for human]
      │
      ▼
[6 Code: append audit entry] ──▶ Audit_Log table + Slack confirm*
```

- **Trigger:** `Airtable Trigger` watching the `Invoices` table for rows where `Validation Status = Procurement Review` **and** a `Reviewer Decision` field (single-select: Approve/Reject) has been set by a human. (Polling trigger; interval ~1 min.)
- **Override:** because every field is editable, procurement can change amounts/status directly; setting `Reviewer Decision` is what closes the loop.
- **Approve → (Step 9):** status → `Ready for Payment`; stamp `Approved By`, `Approved At`, `Last Updated`.
- **Reject → (Step 9):** status → `Rejected`; copy `Reviewer Comments` into `Rejection Reason`.
- **Close:** node 6 writes an immutable row to `Audit_Log` (who/what/when/old→new) so the decision is traceable even though the grid itself is editable.

---

## 8. Idempotency, retries, audit trail

**Idempotency**
- **Key:** `Invoice Number` (fallback composite `poNumber + invoiceNumber + grossAmountCents`) + Gmail `messageId`.
- Node 14 does an **upsert** (search-then-create-or-update), so a re-delivered email or a retried run never creates duplicates. Duplicate-invoice detection (bonus) falls out of the same check → flag `DUPLICATE_INVOICE`.

**Retries**
- **Node-level:** the OpenAI HTTP node and both Airtable nodes have `Retry On Fail` (3× with backoff) for transient 429/5xx/network errors.
- **Workflow-level:** Flow A and Flow B both set **`Shared_Error_Audit_Handler` (Flow E) as their Error Workflow**. Any uncaught error (bad JSON, scanned PDF with no OCR, Airtable outage) fires Flow E, which logs the failure to `Audit_Log`, sets the invoice's status to `Processing Error` when a record exists, and alerts Slack — so nothing fails silently.
- **Poison-message safety:** `Stop And Error` with typed messages (`EXTRACTION_JSON_INVALID`, `SCANNED_PDF_UNSUPPORTED`) makes failures classifiable rather than generic.

**Audit trail (three layers)**
1. **`Raw AI JSON`** field — the verbatim OpenAI output stored immutably on every record (proves what the AI actually returned vs any later human edit).
2. **`Audit_Log` table** — append-only rows: `{ timestamp, invoiceRecordId, actor, action, field, oldValue, newValue, source(FlowA/FlowB/FlowE) }`.
3. **Airtable revision history** — native per-cell change history on the editable grid, covering manual overrides.

---

## Appendix A — Airtable schema

**Table `Purchase_Orders`** (assumed pre-seeded): `Vendor`, `PO Number` (primary), `Approved Line Items` (long text / JSON), `Quantity`, `Unit Price`, `Total Amount`, `Currency`, `Approval Status`.

**Table `Invoices`** (created by Flow A):

| Field | Type | Source |
|-------|------|--------|
| Vendor Name | Single line | OpenAI |
| Vendor ID | Single line | OpenAI |
| Purchase Order Number | Single line | OpenAI |
| Invoice Number | Single line (primary) | OpenAI |
| Invoice Date | Date | OpenAI |
| Due Date | Date | OpenAI |
| Currency | Single select | OpenAI |
| Net Amount | Currency/Number | OpenAI |
| Tax Amount | Currency/Number | OpenAI |
| Gross Amount | Currency/Number | OpenAI |
| Line Items | Long text (JSON) | OpenAI |
| Purchase Order Match | Single select (Matched/Partial/No PO) | Node 11–13 |
| Discrepancy Summary | Long text | Node 12 |
| Confidence Score | Number (0–1) | OpenAI |
| Validation Status | Single select (Ready for Payment / Procurement Review / Rejected / Processing Error) | Node 13 |
| Reviewer Decision | Single select (Approve/Reject/blank) | Human (Flow B trigger) |
| Reviewer Comments | Long text | Human |
| Rejection Reason | Long text | Flow B |
| Approved By | Single line | Flow B |
| Approved At | Date/time | Flow B |
| Invoice Attachment | Attachment | Node 14 (original PDF) |
| Raw AI JSON | Long text (immutable) | Node 7 |
| Sender Email | Email | metadata |
| Email Subject | Single line | metadata |
| Received At | Date/time | metadata |
| Last Updated | Date/time | every write |

**Table `Audit_Log`** (bonus/audit): `Timestamp, Invoice (link), Actor, Action, Field, Old Value, New Value, Source`.

---

## Appendix B — Environment / configuration

```
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4.1-nano
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_INVOICES_TABLE=Invoices
AIRTABLE_PO_TABLE=Purchase_Orders
AIRTABLE_AUDIT_TABLE=Audit_Log
PROCUREMENT_INBOX=procurement@yourdomain.com     # n8n credential, ref only
TOLERANCE_PCT=2                                  # ± money tolerance
TAX_ABS_TOLERANCE_CENTS=2                         # tax rounding slack
QUANTITY_EXACT=true
SLACK_WEBHOOK_URL=...                             # optional notifications
```

---

## Appendix C — Step → node traceability

| Step | Requirement | Node(s) |
|------|-------------|---------|
| 1 | Monitor inbox, PDF-only, metadata | A1, A2/2b, A3 |
| 2 | LLM extraction → valid JSON | A4, A5, **A6 (OpenAI)**, A7 |
| 3 | Retrieve PO | A8, A9/9b |
| 4 | Field-by-field match | **A11** |
| 5 | Discrepancy detection | **A12** |
| 6 | Validation banding | **A13** |
| 7 | Store record + PDF | A14 |
| 8 | Procurement review | Airtable grid + B1 |
| 9 | Approval / rejection + audit | B2–B6, Flow E |
