# MASTER PLAN — Task 2: AI Purchase Order Matching & Invoice Validation

> **This is the document you open first.** It is the single source of truth for building,
> polishing, and submitting Task 2 within the remaining time. Every other doc in this repo
> is a deep-dive that this plan points you to. Follow the BUILD PLAN (§4) top to bottom.

- **Role:** AI Engineer, Round 3
- **Hard deadline:** 72h total, **~2.5 days remaining** as of now (2026-07-03).
- **Deliverables:** exported n8n workflow JSON · DB schema · AI prompts · sample POs + invoices · README · 5–10 min demo video · public GitHub repo.
- **Design principle (headline claim of the whole submission):** *The LLM extracts FACTS ONLY. Every pass/fail decision — PO matching, discrepancy detection, validation banding — is DETERMINISTIC JavaScript in n8n Code nodes.* This makes the business logic auditable, unit-testable, and gradeable, and guarantees the same invoice always yields the same verdict regardless of LLM sampling.

---

## 1. Solution summary + stack (and WHY)

We build an **AI-powered procurement pipeline in n8n**. Supplier invoices arrive as PDF attachments in a procurement inbox. n8n detects them, extracts the PDF text, and calls **OpenAI (`gpt-4.1-nano`, temperature 0)** to return a strict JSON of invoice *facts*. n8n then retrieves the matching approved **Purchase Order from Airtable**, runs a **deterministic JavaScript matching engine** that compares invoice vs PO field-by-field (money in integer cents, configurable tolerances), classifies discrepancies as MINOR/MAJOR, and bands the result into **Ready for Payment / Procurement Review / Rejected**. The full record — extracted data, PO reference, structured comparison, discrepancy report, and the original PDF — is written to Airtable. The **editable Airtable grid IS the procurement-review UI**: a reviewer can override, approve, or reject with comments, and a second n8n workflow finalizes status, stamps approval/rejection audit fields, and appends to an audit log. All failures fail *soft* into a central error/audit handler so nothing is ever dropped silently.

**Decided stack (use consistently; do not offer alternatives as the primary path):**

| Layer | Choice | Why |
|---|---|---|
| Orchestration | **n8n** (workflows exported as JSON) | The exported JSON is a headline graded deliverable; visual flow doubles as demo material. |
| LLM | **OpenAI `gpt-4.1-nano`, temp 0** | Deterministic-as-possible extraction; called via **HTTP Request node** for exact control of model/temperature/headers and copy-pasteable `curl` parity. |
| Decisions | **Deterministic JS in n8n Code nodes** | Auditable, testable, reproducible. Never delegate pass/fail to the LLM — this is the core selling point. |
| Database | **Airtable** | First-class Attachment field for the PDF; editable grid = zero-build review UI; native revision history = audit backstop; mature n8n node with upsert. |
| Human-in-the-loop | **Airtable grid** (review/override/approve/reject/comments) | No separate app to build; reviewers work where the data lives. |

---

## 2. Architecture at a glance

Three n8n workflows. Full detail in **`docs/ARCHITECTURE.md`**.

| Flow | Name | Trigger | Responsibility | Steps |
|---|---|---|---|---|
| **A** | `PO_Ingest_Extract_Match_Store` | Gmail Trigger (poll ~1 min) | email → PDF filter → text extract → OpenAI extraction → PO retrieve → deterministic match → discrepancy detect → validation band → write Airtable + attach PDF | 1–7 |
| **B** | `PO_Approval_Status_Updater` | Airtable Trigger (reviewer sets decision) | read human decision + comments → apply approve/reject → stamp audit fields → finalize status → append audit log | 8–9 |
| **C** | `Shared_Error_Audit_Handler` | Execute-Workflow / set as **Error Workflow** for A & B | central catch: append to `Audit_Log`, alert Slack, mark invoice `Processing Error` | cross-cutting |

> **Naming decision (locked):** the three flows are **A / B / C**. (The architecture doc historically labeled the third "E" — treat every "Flow E" reference as **Flow C**. Rename on export so there is no A/B/E gap for a grader to question.)

```
 procurement     ┌────────────────────────────────────────────┐
 inbox  ────────▶│ FLOW A: Ingest → Extract → Match → Store    │──writes──┐
                 └────────────────────────────────────────────┘          ▼
                         │ on error                              ┌──────────────────┐
                         ▼                                       │     Airtable     │
                 ┌──────────────────────────┐                    │  Purchase_Orders │
                 │ FLOW C: Error/Audit hdlr │◀──────logs────────▶│  Invoices        │
                 └──────────────────────────┘                    │  Audit_Log       │
                         ▲ on error                              └──────────────────┘
                         │                                                ▲
 human edits    ┌──────────────────────────┐                             │
 grid decision ▶│ FLOW B: Approval/Status  │──────────updates────────────┘
                 └──────────────────────────┘
```

**Why three flows:** different triggers/lifecycles (email event vs human editing hours later), independent retries/idempotency, independent scaling of the cost-bound extraction path, and one single audit surface for all failures.

---

## 3. End-to-end data flow for a single invoice (plain language)

1. A supplier emails `invoice.pdf` to the procurement inbox.
2. **Flow A** wakes on poll, sees a PDF attachment, captures **Sender Name, Sender Email, Subject, Received At**. (No PDF → ignored; recorded as skipped.)
3. n8n extracts the PDF text layer. If the text is near-empty, it's a scanned PDF → OCR fallback (bonus) or a typed `SCANNED_PDF_UNSUPPORTED` error into Flow C.
4. OpenAI receives the text + extraction prompt and returns **facts-only JSON**: vendor, PO number, invoice number, dates, currency, net/tax/gross, line items, confidence, warnings. n8n parses it defensively (strip fences, assert keys) and stores the raw output immutably.
5. n8n searches Airtable `Purchase_Orders` by PO number. Found → carry PO fields forward. Not found → synthesize a `found:false` PO stub so "Missing PO" becomes a normal MAJOR discrepancy, not a crash.
6. The **deterministic matching engine** compares invoice vs PO field-by-field — PO number & currency exact; money within ±2% (cents math); quantity exact; tax with a small rounding tolerance; line items aligned by SKU then description similarity — producing a structured field-by-field result.
7. The **discrepancy detector** turns mismatches into a typed list (missing PO, vendor mismatch, quantity mismatch, unit-price mismatch, additional/missing line items, tax-calc error, invoice-exceeds-PO), each MINOR or MAJOR, plus a human-readable summary.
8. **Validation banding:** any MAJOR → `Rejected`; else any MINOR → `Procurement Review`; else `Ready for Payment`.
9. n8n **upserts** an `Invoices` record (create, or update if the invoice number already exists → duplicate-safe) with all extracted data, PO link, structured comparison, discrepancy report, confidence, status, and the **attached PDF**.
10. If status is `Procurement Review`, an optional Slack ping links the reviewer to the row.
11. A human opens the row in the Airtable grid, reads the discrepancy summary, views the PDF, and sets the decision + comments. **Flow B** finalizes: approve → `Ready for Payment` + approval timestamp + approver; reject → `Rejected` + rejection reason. Either way an immutable **Audit_Log** row records who/what/when/old→new.

---

## 4. BUILD PLAN — phased, walking-skeleton-first (~2.5 days)

**Strategy:** get a thin end-to-end path (email → extract → store a stub record) working *first*, then layer matching, banding, approval, error handling, and polish. Never spend a full day on any one node before the skeleton runs.

Total budget ≈ **20 working hours** across 2.5 days, with ~2h float. Phases 0–3 are the non-negotiable spine; 4–8 make it score maximally; 9 is polish.

> **The completeness critic's blocker gaps are folded into Phases 0–2 below.** Do them in order — several are runtime-breaking, not cosmetic.

### Phase 0 — Repo hygiene & config (BLOCKERS FIRST) — ~1.5h
The repo root currently still shows **Task 3 (Resume Screening)** content. A grader opening it sees the wrong assignment. Fix before anything else.
- [ ] Overwrite `README.md` with the Task-2 README (see §5). Delete any resume-screening prose.
- [ ] Overwrite `docs/ARCHITECTURE.md` — it currently holds Task-3 content; replace with the Task-2 architecture (the invoice design synthesized for this project).
- [ ] Overwrite `docs/SCHEMA.md` — currently Task-3 (Resume/Candidates); replace with the Task-2 Airtable schema.
- [ ] Delete leftover Task-3 files if present (`prompts/01_resume_extraction.md`, `prompts/02_jd_matching.md`, `sample-data/job_description.md`, any candidates data).
- [ ] **Rewrite `.env.example`**: it currently ships an **OpenAI** config (`OPENAI_API_KEY`, `gpt-4.1-nano`, "Structured Outputs"). Replace with OpenAI + Airtable + the canonical env vars in §6. Remove any real-looking key. (Security + stack consistency.)
- **DoD:** repo root reads as Task 2 only; `.env.example` names OpenAI, not OpenAI; no resume files remain.

### Phase 0.5 — Lock the naming contract (RUNTIME BLOCKER) — ~1h
The prompt currently emits `snake_case` (`vendor_name`, `po_number`, `net_amount`, `unit_price`, `confidence`); the matching engine reads `camelCase` (`vendorName`, `poNumber`, `netAmount`, `unitPrice`, `confidenceScore`). **With no adapter, the engine sees `undefined` for every field and flags everything mismatched.** Decide once and align everywhere.
- [ ] **Canonical decision:** keep the prompt's `snake_case` JSON (the LLM contract), and add ONE **"Adapter" Set/Code node** in Flow A immediately after extraction-parse that maps `snake_case` → the engine's expected keys and converts money **major-units → integer cents** there. This keeps the prompt readable and the engine pure.
- [ ] Confirm money-units convention end to end: **prompt emits major units** (e.g. `1234.50`) → **adapter converts to cents** → **engine works in cents internally** → Airtable stores major-unit currency values. (Do NOT have the prompt emit cents.)
- [ ] Align `confidence` (prompt) ↔ `confidenceScore` (engine/schema) in the adapter so the score is never dropped.
- [ ] Pick ONE review-decision field name: **`Approval Decision`** (single-select `Pending/Approve/Reject`) — used by the Flow B trigger and the schema. (Retire the alternate "Reviewer Decision" label.)
- [ ] Pick ONE PO-match vocabulary: **`Matched / Partial / No Match`**.
- [ ] Consolidate env-var names to the single canonical set in §6 and make the engine `CONFIG` read exactly those names.
- **DoD:** a one-page "Field Contract" note (put it at the top of `docs/MATCHING_ENGINE.md` or in the README) lists the exact keys at each boundary; adapter node exists in the plan for Phase 2.

### Phase 1 — Accounts, credentials, Airtable base — ~2h
See the checklist in §6. Create the Airtable base + all three tables + pre-create every single-select option, and store all credentials in n8n.
- **DoD:** n8n has working OpenAI, Airtable, and Gmail credentials; `Purchase_Orders` is seeded with the sample POs; empty `Invoices` and `Audit_Log` tables exist with all fields and single-select options pre-created.

### Phase 2 — Walking skeleton: Flow A email → extract → store stub — ~3.5h
Build the thin vertical slice with NO matching yet.
- [ ] Gmail Trigger → Filter (has PDF?) → Code (capture metadata) → Extract From File (PDF) → Adapter payload → HTTP Request to OpenAI → Code (parse + defensive JSON, store `Raw AI JSON`) → **Adapter node (Phase 0.5 mapping)** → Airtable Create `Invoices` (extracted fields + attach PDF, status left blank).
- [ ] Verify with sample invoice **A** emailed in: a real row appears with correct fields and the PDF attached.
- **DoD:** emailing one sample PDF produces one Airtable row with extracted data + attachment, end to end, no matching yet.

### Phase 3 — Deterministic matching, discrepancy, banding — ~3h
This is the crown jewel and already fully designed/tested in **`docs/MATCHING_ENGINE.md`**.
- [ ] Add Airtable Search `Purchase_Orders` by PO number + IF (found?) + synth-Missing-PO branch.
- [ ] Add Merge → Code (Matching Engine) → Code (Discrepancy Detector) → Code (Validation Banding). Paste the verified engine from `docs/MATCHING_ENGINE.md`; wire its `CONFIG` to the canonical env vars.
- [ ] Map results into the Airtable write: `Purchase Order Match`, `Field Comparisons` (JSON), `Discrepancy Summary`, `Discrepancy Severity`, `Validation Status`.
- [ ] Regression-test with sample invoices A (clean→Ready), B (minor→Review), C (major→Rejected), D (missing PO→Rejected).
- **DoD:** all four canonical outcomes reproduce exactly the documented verdicts on live data through the workflow.

### Phase 4 — Flow B: procurement review + approval — ~2h
- [ ] Airtable Trigger on `Invoices` where `Approval Decision` is set. Switch on decision → Approve: status `Ready for Payment`, stamp `Approved By`, `Approved At`, `Last Updated`. Reject: status `Rejected`, copy comments → `Rejection Reason`.
- [ ] Append audit row to `Audit_Log`.
- [ ] Create the three saved grid views: **Needs Review** (`Validation Status = Procurement Review`), **Ready for Payment**, **Rejected**.
- **DoD:** setting `Approval Decision` on a review-status row flips status correctly and writes an audit entry; override by editing a cell works.

### Phase 5 — Error handling & resilience (Flow C) — ~2h
Design in **`docs/ERROR_HANDLING.md`**.
- [ ] Build Flow C (Error Trigger): append failure to `Audit_Log`, set invoice `Validation Status = Processing Error` (or write `Processing Errors` field) when a record exists, Slack alert.
- [ ] Set Flow C as the **Error Workflow** for A and B.
- [ ] Enable **Retry On Fail** (3×, backoff) on the OpenAI HTTP node and both Airtable nodes.
- [ ] Add typed `Stop And Error` messages (`EXTRACTION_JSON_INVALID`, `SCANNED_PDF_UNSUPPORTED`).
- [ ] Verify with sample **F** (malformed/scanned): fails soft into the log, no crash, nothing dropped.
- **DoD:** a malformed invoice produces an audit row + error status, never an unhandled crash.

### Phase 6 — Sample data: render & commit PDFs — ~1.5h
`sample-data/SAMPLE_DATA.md` describes 6 invoices but no `.pdf` artifacts exist; the demo needs real PDFs to email in.
- [ ] Render invoices A–F to PDF (print-to-PDF or `fpdf2`/`img2pdf` per the doc) and commit under `sample-data/`.
- [ ] Commit the PO seed JSON used to populate `Purchase_Orders`.
- **DoD:** six committed PDFs plus PO seed data, amounts tying out to line items.

### Phase 7 — High-value bonuses (only the cheap, already-designed ones) — ~1.5h
Pick from designs already in the repo; skip the rest.
- [ ] **Duplicate detection** — falls out of the upsert idempotency check → flag `DUPLICATE_INVOICE` (sample **E** proves it).
- [ ] **Tolerance-based validation** — already in the engine; document the ±2% + tax abs slack.
- [ ] **Configurable thresholds** — already env-driven; mention in README.
- [ ] **Slack notification** — one node on the review branch.
- [ ] *(Stretch)* lift the engine's worked examples into a small **Jest** test file to prove code quality.
- **DoD:** duplicate + tolerance demonstrably work; README documents them.

### Phase 8 — Export, README, final consistency — ~1.5h
- [ ] Export all three workflows to `workflows/*.json`. **Grep the JSON for secrets** (`sk-ant`, `pat`, passwords) before commit — credentials must be referenced, never embedded.
- [ ] Finalize README (§5) with setup, env vars, workflow explanation, assumptions, the severity→band table, and the field contract.
- [ ] Reconcile any remaining vocabulary (discrepancy-type casing, PO-match labels) so README/demo quote ONE set.
- **DoD:** `workflows/` contains three clean, secret-free JSON files; README is complete and matches the build.

### Phase 9 — Demo video + submission — ~1.5h
- [ ] Record 5–10 min per the shot-list in `docs/EXECUTION_PLAN.md`: ingestion → extraction → PO retrieval → matching + discrepancy → DB updates → approval → error handling.
- [ ] Push to a **public** GitHub repo; verify public in an incognito window.
- [ ] Run the pre-submission checklist (§8).
- **DoD:** video uploaded, repo public and clean, submission form complete.

---

## 5. File / deliverable map

| Path | Holds | Status to reach |
|---|---|---|
| `MASTER_PLAN.md` | **This file** — the authoritative build/submission plan. | Done. |
| `README.md` | Setup, env vars, workflow explanation, assumptions, severity→band table, field contract. **Currently Task-3 — rewrite (Phase 0).** | Rewrite. |
| `docs/ARCHITECTURE.md` | Full 3-flow topology, node-by-node, Steps→node traceability. **Currently Task-3 — overwrite (Phase 0).** | Overwrite with Task-2 design. |
| `docs/MATCHING_ENGINE.md` | Deterministic engine: copy-pasteable n8n Code node, input/output contracts, tolerances, 4 verified worked examples. **Correct & on disk.** | Keep; add field-contract note. |
| `docs/SCHEMA.md` | Airtable schema: `Purchase_Orders`, `Invoices` (+ optional line-item child tables), `Audit_Log`, single-select options. **Currently Task-3 — overwrite (Phase 0).** | Overwrite with Task-2 schema. |
| `docs/ERROR_HANDLING.md` | Error matrix, retry policy, Flow C, security, scalability, bonus plan. **Correct & on disk.** | Keep. |
| `docs/EXECUTION_PLAN.md` | Detailed phase/hour plan, credential checklist, test matrix, demo shot-list. **Correct & on disk.** | Keep (this MASTER_PLAN summarizes it). |
| `prompts/ai_prompts.md` | Prompt 1 (extraction, required) + Prompt 2 (discrepancy summary, optional) + defensive parsing helper. **Correct & on disk.** | Keep; align keys per Phase 0.5. |
| `sample-data/SAMPLE_DATA.md` | 3 vendors, 3 POs (+ seed JSON), 6 invoices with expected outcomes, assertion table, render + email instructions. **Correct & on disk.** | Keep; render PDFs (Phase 6). |
| `sample-data/*.pdf` | The six rendered invoice PDFs to email in. **Missing.** | Create (Phase 6). |
| `workflows/flow_a_ingest_extract_match_store.json` | Exported Flow A. **Missing — headline deliverable.** | Build & export (Phases 2–3). |
| `workflows/flow_b_approval_status_updater.json` | Exported Flow B. **Missing.** | Build & export (Phase 4). |
| `workflows/flow_c_error_audit_handler.json` | Exported Flow C. **Missing.** | Build & export (Phase 5). |
| `.env.example` | Canonical env vars (§6). **Currently OpenAI — rewrite (Phase 0).** | Rewrite for OpenAI/Airtable. |

---

## 6. Account / credential setup checklist (do this now)

**Create right away — everything downstream depends on it.**

- [ ] **n8n** — Cloud trial or local (`docker`/`npx n8n`). If local + Gmail webhook, use tunnel mode. Set Flow C as the instance/workflow Error Workflow.
- [ ] **OpenAI** — API key; confirm access to `gpt-4.1-nano`. Store as n8n credential / `OPENAI_API_KEY`. Temperature 0.
- [ ] **Airtable** — create base `Procurement`. Personal Access Token scoped `data.records:read`, `data.records:write`, `schema.bases:read`, limited to this base. Grab `AIRTABLE_BASE_ID`.
  - [ ] Table `Purchase_Orders` — seed with sample POs from `sample-data/SAMPLE_DATA.md`.
  - [ ] Table `Invoices` — all fields per `docs/SCHEMA.md`; **pre-create every single-select option** (Airtable API rejects unknown options).
  - [ ] Table `Audit_Log` — append-only.
- [ ] **Gmail** — OAuth2 credential (or IMAP app password) for the procurement inbox. Enable attachment download.
- [ ] **Slack** *(optional bonus)* — incoming webhook URL for notifications.

**Canonical env vars (put these in `.env.example`, Phase 0):**

```
# LLM — OpenAI (NOT OpenAI)
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4.1-nano

# Airtable
AIRTABLE_API_KEY=pat...
AIRTABLE_BASE_ID=app...
AIRTABLE_PO_TABLE=Purchase_Orders
AIRTABLE_INVOICES_TABLE=Invoices
AIRTABLE_AUDIT_TABLE=Audit_Log

# Inbox
PROCUREMENT_INBOX=procurement@yourdomain.com

# Validation tolerances (canonical names — engine CONFIG must read these)
MONEY_TOLERANCE_PCT=0.02          # ±2% relative tolerance on net/tax/gross/unit price
TAX_ABS_TOLERANCE_CENTS=2         # absolute rounding slack on tax
QTY_EXACT_MATCH=true              # quantity must match exactly

# Optional / bonus
DUPLICATE_POLICY=flag
OCR_ENABLED=false
SLACK_WEBHOOK_URL=
```

> Note: PO number and currency always match **exactly** (not tolerance-driven), so they have no env var by design.

---

## 7. What to build vs skip, and top risks

**BUILD (the spine that must be flawless):**
- All three flows working end to end (A, B, C).
- Deterministic matching engine with 4 discrepancy outcomes proven on live data (clean / minor / major / missing-PO).
- Airtable write with PDF attachment + grid-as-review-UI + approval finalization + audit log.
- Clean error handling (retries + Error Workflow + fail-soft + typed errors).
- README, prompts, schema, six sample PDFs, exported JSON, demo video.

**BUILD IF TIME (cheap, already designed):** duplicate detection, tolerance docs, configurable thresholds, Slack notify, a small Jest test.

**SKIP unless everything else is done (ordered cut list):** OCR for scanned PDFs → three-way match (GRN) → multi-currency FX → extra discrepancy types beyond the core set → dedicated child line-item tables (JSON long-text is an acceptable fallback). *Prefer 3–4 rock-solid discrepancy types + clean error handling over ten half-working ones.*

**Top risks (and mitigations):**
1. **No workflow JSON exists yet** — the single headline deliverable. *Mitigation:* Phases 2–5 are front-loaded; build the skeleton (Phase 2) before anything fancy.
2. **snake_case/camelCase contract break** would make the engine flag everything mismatched at runtime. *Mitigation:* the Phase 0.5 adapter node + field-contract note; test on sample A immediately after Phase 2.
3. **Repo presents the wrong task** (Task-3 README/SCHEMA/ARCHITECTURE/.env). *Mitigation:* Phase 0 overwrites all four before any build.
4. **Secrets leaking into exported JSON** (`.env.example` even ships an OpenAI-style key today). *Mitigation:* credentials as n8n credentials only; grep exports before commit (Phase 8).
5. **Airtable single-select rejects unknown options** at write time. *Mitigation:* pre-create every option in Phase 1.
6. **Time overrun.** *Mitigation:* the cut list above; the spine (Phases 0–3) is only ~11h and delivers a gradable core even if bonuses are dropped.

---

## 8. Pre-submission checklist (mapped to the submission form)

**Deliverables present & correct**
- [ ] `workflows/` contains **three exported JSON files** (A, B, C), imported-and-runnable, **no secrets** (grep `sk-ant`, `pat`, passwords).
- [ ] `docs/SCHEMA.md` describes the **Airtable** tables actually built (fields + single-select options).
- [ ] `prompts/ai_prompts.md` — extraction + discrepancy prompts, keys aligned to the field contract.
- [ ] `sample-data/` — six invoice **PDFs** + PO seed data, amounts tying out.
- [ ] `README.md` — setup, env vars, workflow explanation, **assumptions**, severity→band table, field contract; describes Task 2 only.
- [ ] Demo video **5–10 min** covering: ingestion, AI extraction, PO retrieval, validation + discrepancy detection, DB updates, approval workflow, error handling.

**Consistency & correctness**
- [ ] Repo root reads as **Task 2** — no leftover Task-3 (resume) content anywhere.
- [ ] `.env.example` names **OpenAI**, not OpenAI; canonical env-var set; no real keys.
- [ ] One naming convention documented end to end (prompt keys → adapter → engine → Airtable); one PO-match vocabulary; one discrepancy-type casing quoted in docs/demo.
- [ ] Sample invoices A–F reproduce their documented verdicts through the live workflow.
- [ ] Error path verified: malformed/scanned invoice fails soft into `Audit_Log`, nothing dropped.

**Submission hygiene**
- [ ] GitHub repo is **public** — verified in an incognito window.
- [ ] Submission form links all point to the public repo + video and open cleanly.
- [ ] Approval + rejection both produce correct status, timestamps, and audit entries.

---

*Follow the phases in order. The spine (Phases 0–3) turns "strong design, nothing gradable" into "working, demonstrable submission." Everything after is score maximization.*
