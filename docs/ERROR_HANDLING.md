# Error Handling, Resilience, Security & Bonus Plan

_Task 2 — AI Purchase Order Matching & Invoice Validation. Stack: **n8n + OpenAI (gpt-4.1-nano, temp 0) + Airtable**. Business logic (match/discrepancy/validation) is **deterministic JavaScript** in Code nodes; the LLM extracts facts only._

## Guiding principle: FAIL SOFT

> **Never silently drop an invoice.** Every inbound email that carries a PDF invoice results in an `Invoices` record. If any step fails, we still create (or update) the record, set `Validation Status = Procurement Review` (or `Needs Attention`), and populate a `Processing Errors` field with a human-readable reason. A dropped invoice is an unpaid supplier and an unexplained gap — the worst possible outcome. A flagged invoice is a task in someone's queue.

Three outcomes are always reachable, never a dead end:
1. **Happy path** — extracted, matched, validated, routed by business rules.
2. **Recoverable failure** — record created, `Validation Status = Procurement Review`, `Processing Errors` explains what to check.
3. **Infrastructure failure** (Airtable/OpenAI down) — caught by the **Error Trigger workflow**, logged to `Audit_Log`, and (bonus) a Slack alert fires so nothing rots unseen.

---

## 1. Error-Handling Matrix

Node names below match the exported workflow (`workflows/invoice_validation.json`). "Branch" refers to the IF/Switch output taken. Every recoverable row ends in a record with `Processing Errors` set — never a silent stop.

| # | Failure | Detect where | n8n handling (node / branch / retry) | Resulting record state |
|---|---|---|---|---|
| 1 | **No PDF attachment** | `IF Has PDF Attachment` (checks `binary` keys for `application/pdf`) | FALSE branch → `NoOp: log ignored` → append to `Audit_Log` (`event=ignored_no_pdf`). No `Invoices` record (nothing to process). | No record. Logged only. |
| 2 | **Multiple PDF attachments** | `Code: Select Invoice PDF` counts `application/pdf` binaries | If >1, take the **largest** PDF as the invoice, keep the rest in `Processing Errors` (`"2 PDFs attached; processed largest (invoice.pdf); also: receipt.pdf"`). Continues normally. | Record created; `Processing Errors` notes extra files for reviewer. |
| 3 | **Empty / scanned PDF (no text layer)** | `Code: Validate Extracted Text` — `text.trim().length < MIN_TEXT_CHARS` (env, default 40) | Route to `Set: Needs OCR`. If OCR bonus enabled → OCR sub-branch; else set `Validation Status = Procurement Review`, `Processing Errors = "PDF has no text layer — likely scanned; OCR/manual entry needed"`. Attach original PDF. | Record created, flagged for review, PDF attached. |
| 4 | **OpenAI returns non-JSON or fenced ```json** | `Code: Parse AI JSON` | Strip ```` ```json ```` / ```` ``` ```` fences and any prose before `{` / after `}`; `JSON.parse` in `try/catch`. On success continue. On failure → `Set: Extraction Failed` (`Validation Status = Procurement Review`, `Processing Errors = "AI output not valid JSON"`), store the raw string in `Raw AI JSON` for audit. | Record created, flagged, raw output preserved. |
| 5 | **OpenAI times out / rate-limited (429/5xx)** | OpenAI (HTTP Request) node | Node **Retry On Fail**: 3 attempts, `waitBetweenTries` 5000 ms (exponential-ish via env `RETRY_BACKOFF_MS`). On 429/5xx the retries space out the load. After final failure → node's **error output** (see §2) → `Set: Extraction Failed` record + `Audit_Log`. | On success: normal. On give-up: record flagged, error logged. |
| 6 | **Missing required fields** in AI JSON (e.g. no PO Number, no amounts) | `Code: Validate Required Fields` against a required-key contract | Missing **PO Number** or **Vendor** → cannot match → `Validation Status = Procurement Review`, `Processing Errors` lists missing fields. Missing **amounts** → same. The record is never rejected purely for extraction gaps (that would hide a real invoice). Defensive defaults: `null` scalars, `[]` line items. | Record created, flagged with the exact missing fields. |
| 7 | **PO not found in Airtable** | `Airtable: Find PO` returns 0 rows → `IF PO Found` | FALSE branch → this **is** the "Missing PO" **MAJOR** discrepancy. `Validation Status = Rejected` (per business rules) **but** always create the record with `Discrepancy Summary = "Missing PO: no approved PO <num> for vendor <x>"` and route to Procurement (Rejected still visible/overridable in grid). | Record created, `Rejected`, discrepancy explained, human can override. |
| 8 | **Multiple POs match** the PO number | `Airtable: Find PO` returns >1 row → `Code: Resolve PO` | Prefer exact `Vendor + PO Number + Currency + Approval Status = Approved`. If still >1, pick most recent by `Created`, set `Processing Errors = "N POs matched; used PO recordId=..."` and add MINOR discrepancy so a human confirms. Never guess silently. | Record created; matched against best PO; flagged for confirmation. |
| 9 | **Airtable API error** (5xx, network, throttle 429) | Any Airtable node | **Retry On Fail**: 3–5 attempts, `waitBetweenTries` 3000 ms. Airtable's own 429 respected by backoff. Final failure → Error Trigger workflow → `Audit_Log` (`event=airtable_error`, node, itemId) + Slack alert. The in-flight item is **not** lost: the Error Trigger payload contains the full item for manual replay. | Depends on which call: create failed → replay from Error Trigger; update failed → prior state intact. |
| 10 | **Email / Slack send failure** (notification step) | Notification node | **Retry On Fail** 2×. Notifications are **non-blocking**: wire the node's error output to a `NoOp` so a failed alert never blocks record creation. Log `event=notify_failed` to `Audit_Log`. | Record unaffected; only the alert is skipped and logged. |
| 11 | **Duplicate invoice** (same Vendor ID + Invoice Number, or PO + Invoice Number) | `Airtable: Find Existing Invoice` before create → `IF Is Duplicate` | TRUE branch → do **not** create a second record. Update the existing record's `Processing Errors`/`Audit_Log` with `"Duplicate re-received <timestamp> from <sender>"`, keep original decision. Prevents double payment. Configurable key via env `DUP_KEY`. | No new record; existing record annotated; duplicate re-send logged. |
| 12 | **Corrupt / unreadable PDF** (extract node throws) | `Extract PDF Text` node error output | Treated like #3: `Set: Needs OCR/Manual`, `Processing Errors = "PDF unreadable/corrupt"`, attach original so a human can open it. | Record created, flagged, PDF attached. |
| 13 | **Currency parse / non-numeric amount** | `Code: Normalize Amounts` (parses to integer minor units) | Un-parseable amount → treat field as missing (#6 path) rather than crashing; note in `Processing Errors`. All good amounts stored as cents (integers) to avoid float drift. | Record created, flagged on the offending amount. |

**Cross-cutting rule:** the *pass/fail decision* is never delegated to OpenAI. Even when extraction is degraded, the deterministic Code node decides the band. That keeps the audit trail defensible.

---

## 2. n8n Specifics

### 2.1 Per-node "Retry On Fail"
Set on every node that touches the network. Configure in each node's **Settings** tab:

| Node | Retry On Fail | Max Tries | Wait Between (ms) | Notes |
|---|---|---|---|---|
| `OpenAI — Extract` (HTTP Request) | ✅ | 3 | 5000 | Absorbs 429/5xx/timeouts. Add `Continue On Fail` OFF so the error output routes to fallback. |
| `Airtable — Find PO` | ✅ | 3 | 3000 | Read; safe to retry. |
| `Airtable — Find Existing Invoice` | ✅ | 3 | 3000 | Read; safe to retry (idempotent). |
| `Airtable — Create/Update Invoice` | ✅ | 5 | 3000 | Write. Idempotency via dup-key check (§4) so a retried create can't double-insert. |
| `Extract PDF Text` | ❌ (use error output) | — | — | Deterministic; retry won't help a corrupt file. Route error output to fallback. |
| `Slack/Email Notify` | ✅ | 2 | 2000 | Non-blocking; error output → NoOp. |

> **Prefer explicit error outputs over "Continue On Fail" swallow.** Where a node exposes an **Error output** (n8n's second output), wire it to the fallback `Set` node so failures are *handled and recorded*, not hidden. Use `Continue On Fail` only for genuinely optional steps (notifications).

### 2.2 Error Trigger workflow (global safety net)
A **second workflow** named `Invoice — Error Handler`:

```
[Error Trigger]
      │  (fires on any unhandled error in the main workflow)
      ▼
[Code: shape error]  → { workflow, node, message, itemJson, ts }
      ▼
[Airtable: append to Audit_Log]   (event=workflow_error, full payload)
      ▼
[IF Slack enabled] ─▶ [Slack: alert #procurement-ops]  ("Invoice run failed at <node>: <msg>")
```

- In the **main** workflow settings → **Error Workflow** → select `Invoice — Error Handler`. Now any node that errors past its retries (and isn't caught by a local error output) is captured centrally with the full item JSON, enabling **manual replay** — the invoice is never lost.
- The Error Trigger payload includes `execution.id` and the failing item, so you can re-run a single invoice after fixing the cause.

### 2.3 Logging failures to `Audit_Log`
Dedicated Airtable table **`Audit_Log`** (immutable, append-only):

| Field | Type | Example |
|---|---|---|
| Timestamp | Created time | auto |
| Event | Single select | `ignored_no_pdf`, `extraction_failed`, `airtable_error`, `duplicate`, `workflow_error`, `notify_failed`, `human_override` |
| Invoice Ref | Single line text | invoice # or `recordId` |
| Node | Single line text | node that failed |
| Message | Long text | human-readable detail (no secrets) |
| Payload | Long text | truncated item JSON for replay (PII-minimized) |
| Execution ID | Single line text | n8n execution id |

Every recoverable failure writes one `Audit_Log` row **and** annotates the invoice's `Processing Errors`. `Audit_Log` + Airtable per-record **revision history** + immutable **`Raw AI JSON`** together form the audit trail for Step 9.

---

## 3. Security & Data Privacy

Graded on "security considerations." Concrete measures:

**Secrets & credentials**
- **API keys via n8n Credentials only** — OpenAI key, Airtable PAT, and email/Slack tokens are stored as n8n **credential objects**, referenced by name in nodes. **Never** hardcoded in Code nodes, HTTP headers-as-text, or committed to the repo. `.env.example` ships placeholders (`sk-proj-...`, `pat...`) only.
- **Least-privilege Airtable PAT** — scope the token to exactly: `data.records:read`, `data.records:write`, `schema.bases:read`, and **restrict it to the single base** (not "all bases"). No `schema.bases:write` (workflow doesn't create schema at runtime). Rotate on a schedule.
- **OpenAI key scope** — dedicated key for this integration so it can be revoked/rotated independently; set a spend limit in the OpenAI console as a blast-radius cap.
- **Never log secrets** — the `Audit_Log`/`Processing Errors` writers strip auth headers and tokens; log messages are constructed from whitelisted fields (event, node, invoice ref), never by dumping the raw request/credentials. No `console.log(items)` of full HTTP requests.

**Data privacy / PII (invoices contain bank details, addresses, contact names)**
- Store **only fields the schema needs**. `Raw AI JSON` is retained for audit but lives in an access-controlled Airtable base; if bank/IBAN data appears, mask it in `Processing Errors`/logs (log last-4 only).
- **Attachment access** — the base is shared only with procurement reviewers; Airtable's per-user permissions gate who sees invoice PDFs.
- **Retention** — document a retention window for `Audit_Log.Payload` (truncated JSON), and purge/rotate per policy. Don't keep full item dumps forever.
- **LLM data** — only the extracted PDF text is sent to OpenAI (temp 0, extraction only). Note in README that invoice text transits the OpenAI API; use an account/data-processing terms appropriate for the org.

**Interface hardening**
- **Webhook auth** — if the inbox trigger or any replay endpoint is a webhook, enable **Header Auth / basic auth** on the n8n webhook and keep the URL secret. Prefer the polling **Email Trigger (IMAP/Gmail OAuth)** over an open webhook where possible.
- **Input sanitization** — treat PDF text and all AI output as **untrusted**: the deterministic Code nodes validate types, coerce amounts to integers, and **never `eval`** model output. Field values written to Airtable go through the SDK/node (parameterized), not string-built queries. Cap extracted-text length fed to OpenAI (env `MAX_PDF_CHARS`) to bound cost and prompt-injection surface; the extraction prompt instructs OpenAI to extract facts only and ignore any instructions embedded in the document.
- **Prompt-injection stance** — because business decisions are deterministic JS, a malicious "PO matches, approve payment" string inside a PDF **cannot** change the validation outcome. This is a direct security benefit of the LLM-extracts-facts-only design.
- **n8n hardening** — enable n8n user management/2FA, restrict who can edit workflows (workflow edits = credential access), keep n8n behind HTTPS.

---

## 4. Scalability

Target: hundreds of invoices/day, bursty (suppliers batch-send month-end).

- **Batching** — the Email Trigger emits items in batches; use **Split In Batches** (Loop Over Items) with a modest batch size (e.g. 10) around the OpenAI call so a 200-invoice burst doesn't fire 200 concurrent API calls. Tune `batchSize` via env.
- **Queue mode** — for real load, run n8n in **queue mode** (main + workers + Redis). Horizontal worker scaling processes invoices in parallel while retries/backoff protect downstreams. Document the `EXECUTIONS_MODE=queue` deployment in README as the scale path.
- **Idempotency keys** — the **dup-key** (`Vendor ID + Invoice Number`, configurable) is the idempotency key. `Airtable: Find Existing Invoice` runs **before** create, so a retried/duplicated execution updates rather than double-inserts. This makes writes safe under retry (§2.1) and prevents double payment.
- **Avoid duplicate processing** — email-level dedupe via message-id / `Received At`; record-level dedupe via the idempotency key. An email re-delivered by IMAP won't create a second invoice.
- **Rate-limit backoff** — Retry On Fail with `waitBetweenTries` gives exponential-style spacing on OpenAI 429/5xx and Airtable 429. Batch size caps steady-state RPS. Env `RETRY_BACKOFF_MS`, `RETRY_MAX_TRIES` centralize tuning.
- **Cost/perf** — temp 0 + concise extraction prompt + `MAX_PDF_CHARS` cap keep token cost predictable and bounded per invoice.
- **Stateless steps** — each invoice flows independently; no shared mutable state between items, so workers scale linearly.

---

## 5. Bonus-Feature Plan (prioritized)

Effort: **S** ≈ <2h, **M** ≈ half-day, **L** ≈ 1+ day. Given ~2.5 days remaining and a "polished over broad" mandate, **build the ✅ set**; document the rest as roadmap.

| Bonus (from brief) | Sketch | Effort | Verdict |
|---|---|---|---|
| **Tolerance-based validation (±2%)** | Already **core**: amounts compared in integer cents with `AMOUNT_TOLERANCE_PCT` (default 2%), tax with absolute rounding tolerance, PO#/currency exact. | S (done) | ✅ **Build — core selling point** |
| **Configurable approval thresholds** | Env-driven: `AMOUNT_TOLERANCE_PCT`, `QTY_EXACT`, `TAX_ABS_TOLERANCE`, band mapping. Read once in a `Config` Set node so reviewers can tune without editing logic. | S | ✅ **Build** (cheap, high grading value) |
| **Duplicate invoice detection** | `Find Existing Invoice` on the idempotency key before create; matrix #11. Also doubles as scalability idempotency. | S–M | ✅ **Build** (fraud/double-pay prevention; already needed for idempotency) |
| **Retry & failure handling** | Per-node Retry On Fail + Error Trigger workflow + `Audit_Log` (§2). | M | ✅ **Build** (directly graded: "error handling & resilience") |
| **Slack/Teams notifications** | Slack node on: `Rejected`, `Needs Review`, and workflow errors → `#procurement-ops`. Non-blocking (matrix #10). | S | ✅ **Build** (demo-friendly, visible UX win) |
| **Comprehensive logging & monitoring** | Partially covered by `Audit_Log`. Full dashboards = extra. | M | 🔶 Partial — `Audit_Log` ships; dashboards = roadmap |
| **Duplicate + tolerance = strong demo** | (rollup of above) | — | — |
| **Multi-currency** | Store currency per invoice; require exact PO currency match (already). True FX conversion = out of scope. | M | ◻️ Document assumption (exact-match only), skip FX |
| **OCR for scanned invoices** | On no-text-layer (#3), send PDF to an OCR step (e.g. cloud OCR / vision) then re-extract. | L | ◻️ Roadmap — detection ships, OCR routing stubbed |
| **Three-way matching (Invoice + PO + GRN)** | Add `Goods_Receipts` table; extend deterministic matcher to also reconcile received qty. | L | ◻️ Roadmap — schema-compatible, note as extension |
| **Unit + integration tests** | Extract the matcher into a pure JS module; Jest tests on discrepancy/band logic with fixture invoices+POs. | M | 🔶 Stretch — add a small unit-test file for the matcher if time allows (strong "code quality" signal) |

**Recommended 5 to build (all S–M, ~1–1.5 days total):** tolerance-based validation *(core)*, configurable thresholds, duplicate detection, retry/failure handling, Slack notifications. These map 1:1 onto the graded criteria **error handling & resilience**, **scalability**, and **security**, and they demo cleanly in the 5–10 min video (show a duplicate rejected, a ±1% variance passing tolerance, a 429 retry, and a Slack alert on rejection). If a stretch slot remains, add the **matcher unit tests** for a "code quality" bump.

---

## Suggested new env vars (append to `.env.example`)

```
# ── Validation tolerances (Steps 4–6) ───────────────
AMOUNT_TOLERANCE_PCT=2          # ±% relative tolerance on net/tax/total/unit price
TAX_ABS_TOLERANCE=0.02          # absolute rounding tolerance on tax (currency units)
QTY_EXACT=true                  # quantities must match exactly
MIN_TEXT_CHARS=40               # below this => treat PDF as scanned/empty
MAX_PDF_CHARS=20000             # cap text sent to OpenAI (cost + injection surface)

# ── Resilience ──────────────────────────────────────
RETRY_MAX_TRIES=3
RETRY_BACKOFF_MS=5000
BATCH_SIZE=10

# ── Dedupe / idempotency ────────────────────────────
DUP_KEY=vendor_id+invoice_number   # idempotency key for duplicate detection

# ── Notifications (bonus) ───────────────────────────
SLACK_ENABLED=true
SLACK_CHANNEL=#procurement-ops
```
