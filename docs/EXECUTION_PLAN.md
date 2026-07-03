# EXECUTION PLAN — AI Purchase Order Matching & Invoice Validation

**Task:** Task 2 — AI PO Matching & Invoice Validation (AI Engineer, Round 3)
**Deadline:** 72h total, ~2.5 working days / ~45–55 focused hours remaining.
**Stack (fixed):** n8n (workflow JSON) · Airtable (`Purchase_Orders` + `Invoices`) · OpenAI `gpt-4.1-nano` (temp 0, facts-only extraction) · deterministic JavaScript in n8n Code nodes for all matching/validation decisions.
**Core selling point:** the LLM extracts *facts only*; every pass/fail decision is auditable, testable JavaScript.

> **Repo hygiene note (do this first):** the repo currently contains leftover files from a *different* task (`prompts/01_resume_extraction.md`, `prompts/02_jd_matching.md`, `sample-data/job_description.md`, and a resume-oriented `README.md`). **Delete or overwrite all of these in Phase 0** so the submission is coherent. Everything below assumes those are gone.

---

## 0. Guiding principles

1. **Walking skeleton first.** Get email → extract → store a stub record working end-to-end on day 1, *before* any matching logic. A thin thread that runs beats a thick pile of disconnected nodes.
2. **Deterministic decisions.** The LLM never decides pass/fail. It returns JSON facts; JS compares. This is a graded selling point — lead with it in the README and demo.
3. **Money in integer cents.** Convert every amount to minor units on ingestion; compare integers. No float math anywhere in matching.
4. **Config over hardcoding.** Tolerances, thresholds, and the "minor vs major" discrepancy map live in one config block/env, not scattered in nodes.
5. **Demo-ability is a deliverable.** If it can't be shown on video in 8 minutes, it doesn't score. Prefer 3–4 rock-solid discrepancy types with clean error handling over ten half-working ones.
6. **Commit continuously.** Export the workflow JSON and push to GitHub at the end of every phase — never lose a working state.

---

## 1. BUILD SEQUENCE — phases, time, dependencies, definition of done

Times assume a candidate who knows n8n *a little*. Buffers are built in. Total ≈ 48h of the 45–55 available; the surplus is your safety margin.

### Phase 0 — Environment & accounts (2.5h) — *no dependencies*
- Create/verify all accounts and credentials (see Section 2).
- Clean the repo (delete stale resume-task files), confirm folder skeleton `docs/ prompts/ sample-data/ workflows/`.
- Get n8n running (n8n Cloud trial **or** local `npx n8n` / Docker). Confirm you can open the editor and create a credential.
- **DoD:** n8n editor opens; OpenAI, Airtable, and Gmail/IMAP credentials all saved and each tested with a trivial node; empty repo pushed to a **public** GitHub repo.

### Phase 1 — Data foundation: Airtable + sample data (4h) — *depends on 0*
- Build the two Airtable tables with the full schema (Section 3, Step 3 & 7).
- Author **3 sample POs** and **6–7 sample invoice PDFs** (Section 4). Generate PDFs from Markdown/HTML → print-to-PDF, or a tiny script.
- Seed `Purchase_Orders` with the 3 POs.
- **DoD:** both tables exist with correct field types (esp. Attachment + single-select for status); 3 POs visible in `Purchase_Orders`; all sample invoice PDFs saved under `sample-data/invoices/` and their matching PO expectations recorded in `sample-data/EXPECTED_OUTCOMES.md`.

### Phase 2 — WALKING SKELETON: ingest → extract → store stub (7h) — *depends on 1*
This is the make-or-break slice. Everything after is additive.
- **Trigger:** Gmail Trigger (or IMAP) polling the procurement inbox; filter to emails with PDF attachments; capture sender name/email, subject, received timestamp.
- **Guard:** IF node — has PDF attachment? No → mark ignored / stop.
- **Extract text:** Extract-From-File node (PDF → text). (OCR fallback is a bonus, later.)
- **LLM extract:** HTTP Request or OpenAI node → OpenAI `gpt-4.1-nano`, temp 0, using the extraction prompt (Section 3, Step 2). Force VALID JSON.
- **Parse & normalize:** Code node — JSON.parse, convert all amounts to integer cents, stash raw AI JSON verbatim.
- **Store stub:** Airtable Create in `Invoices` — extracted fields + PDF attachment + `Validation Status = "Pending"` + Raw AI JSON + email metadata + Received At.
- **DoD:** drop one sample invoice into the inbox → within a poll cycle a new `Invoices` row appears with correct extracted fields, the original PDF attached, and Raw AI JSON stored. Export workflow JSON, commit.

### Phase 3 — PO retrieval + field-by-field matching (6h) — *depends on 2*
- **Retrieve PO:** Airtable Search in `Purchase_Orders` by PO Number (fallback: by Vendor). Handle "no PO found."
- **Match engine (Code node, deterministic):** compare Vendor, PO Number, Currency, Line Items, Quantity, Unit Price, Net, Tax, Total. Output a **structured field-by-field result**: `{ field, invoiceValue, poValue, match: bool, delta }`. All money in cents; apply tolerances (PO#/currency exact; amounts ±2% configurable; qty exact; tax small absolute rounding tolerance).
- **DoD:** for a clean invoice all fields report `match:true`; for a seeded-mismatch invoice the offending field(s) report `match:false` with correct deltas. Comparison JSON written to the `Purchase Order Match` field.

### Phase 4 — Discrepancy detection + validation bands (5h) — *depends on 3*
- **Discrepancy detector (Code node):** from the match result, emit typed discrepancies: Missing PO, Vendor mismatch, Quantity mismatch, Unit-price mismatch, Additional line items, Missing line items, Incorrect tax calculation, Invoice total exceeds PO value. Each tagged **MINOR** or **MAJOR** via a config map. Build a human-readable **Discrepancy Summary**.
- **Validation bands:** 0 discrepancies → `Ready for Payment`; only MINOR → `Procurement Review`; any MAJOR → `Rejected`.
- **Write-back:** update the `Invoices` row with Discrepancy Summary, Validation Status, Confidence Score, Last Updated.
- **DoD:** each sample invoice lands in the correct band; Discrepancy Summary is readable and matches `EXPECTED_OUTCOMES.md`. Commit.

### Phase 5 — Human-in-the-loop review + approval workflow (5h) — *depends on 4*
- **Review UI = the Airtable grid** (Step 8). Create a filtered view "Needs Review" (Status = Procurement Review). Reviewer edits `Reviewer Comments`, sets an override, and flips an `Action` field (Approve/Reject).
- **Approval workflow (Step 9):** a second small n8n workflow (Airtable Trigger on `Action` change, or scheduled poll) → on Approve set Status `Ready for Payment`, stamp `Approved At`, append to audit log; on Reject set `Rejected`, require/record `Rejection Reason`. Maintain an audit trail (dedicated `Audit_Log` table or append-only field + Airtable revision history + immutable Raw AI JSON).
- **DoD:** flipping a Procurement-Review row to Approve moves it to Ready for Payment with timestamp + audit entry; Reject moves it to Rejected with reason. Commit.

### Phase 6 — Error handling & resilience (4h) — *depends on 2+; do incrementally but harden here*
- Wrap the main workflow with an **Error Trigger** workflow that logs failures to an `Errors`/audit table and (bonus) Slack.
- Handle: malformed/blank PDF, LLM returns non-JSON (retry once, then route to a `Needs Manual Extraction` status), no matching PO, Airtable write failure (retry).
- **Duplicate detection (bonus, cheap & high-value):** before create, search `Invoices` for same Invoice Number + Vendor ID → if found, mark `Duplicate` and skip.
- **DoD:** feed a corrupt PDF and a non-invoice PDF → workflow degrades gracefully, logs the error, does not crash the run; duplicate invoice is caught.

### Phase 7 — Bonuses, pick 2–3 max (3h) — *optional, only if green*
Priority order (highest ROI first): **duplicate detection** (done in P6) → **tolerance-based validation** (already in P3) → **configurable thresholds via env** → **Slack notification on Rejected/Review** → **multi-currency guard** → OCR / three-way match (skip unless well ahead).
- **DoD:** each chosen bonus demoable in ≤30s and documented in README.

### Phase 8 — Docs, sample-data polish, prompts (4h) — *depends on all*
- Finalize README, ARCHITECTURE, SCHEMA, both prompt files, `EXPECTED_OUTCOMES.md` (Section 6).
- **DoD:** a stranger could clone, set env vars, import the workflow, and run a sample end-to-end using only the README.

### Phase 9 — Test pass + demo video + submission (5h) — *depends on all*
- Run the full test matrix (Section 5), fix any surprises.
- Record & lightly edit the 5–10 min demo (Section 6), export final workflow JSON, push, make everything public, fill the submission form.
- **DoD:** all links public and verified in an incognito window; submission form complete.

**Rough total:** 45.5h + ~4h floating buffer inside the 45–55h window.

---

## 2. ACCOUNT & CREDENTIAL SETUP CHECKLIST

Do this whole section in Phase 0 and **test each credential immediately** with a throwaway node.

### n8n
- **Option A (fastest to demo):** n8n Cloud free trial → sign up, you get a hosted editor + a public webhook URL (useful for Airtable triggers).
- **Option B (free, local):** `npx n8n` or Docker (`docker run -it --rm -p 5678:5678 n8nio/n8n`). For Airtable/Gmail webhook triggers locally, expose with a tunnel (`n8n` built-in tunnel or ngrok). Polling triggers work without a tunnel.
- Grab: editor URL, and (Cloud) the instance webhook base URL.

### OpenAI
- Console → **API Keys** → create key (`sk-proj-...`). Put in `.env` as `OPENAI_API_KEY`; add to n8n credentials (OpenAI credential, or as an HTTP header `Authorization: Bearer <OPENAI_API_KEY>`).
- Confirm access to **`gpt-4.1-nano`**. Set **temperature 0**.
- Grab: API key and model id (`gpt-4.1-nano`); the HTTP node sends an `Authorization: Bearer <key>` header.

### Airtable
- Create a base "PO Matching". Note the **Base ID** (`app...`, from the API docs for that base) and each **Table name/ID**.
- **Personal Access Token (PAT):** Airtable → Developer hub → Personal access tokens → create.
  - **Scopes:** `data.records:read`, `data.records:write`, `schema.bases:read`.
  - **Access:** add the "PO Matching" base explicitly.
- Grab: PAT (`pat...`), Base ID, table names `Purchase_Orders` / `Invoices` (+ `Audit_Log`). Put PAT in n8n Airtable credential and in `.env` as `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID`.

### Gmail / IMAP (procurement inbox)
- **Option A — Gmail (recommended for demo):** use a dedicated Gmail account. In n8n use the **Gmail Trigger** node with OAuth2 (create a Google Cloud OAuth client, add n8n's redirect URL, enable Gmail API) **or**, faster, an **App Password** + the IMAP Email Trigger node (requires 2FA on the account, then generate an App Password).
- **Option B — IMAP:** any IMAP mailbox; grab host, port (993 SSL), user, App Password.
- Grab: inbox address (put in README as the procurement inbox), OAuth client id/secret **or** IMAP host/port/user/app-password.

### `.env.example` keys to publish (values redacted)
```
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-nano
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
AIRTABLE_INVOICES_TABLE=Invoices
AIRTABLE_POS_TABLE=Purchase_Orders
IMAP_HOST=
IMAP_PORT=993
IMAP_USER=
IMAP_PASSWORD=
AMOUNT_TOLERANCE_PCT=2
TAX_ROUNDING_TOLERANCE_CENTS=2
SLACK_WEBHOOK_URL=
```

---

## 3. PER-STEP n8n BUILD CHECKLIST (mirrors the 9 functional steps)

> Build Steps 1–2–7-stub in Phase 2 (skeleton), then 3, 4/5/6, then 8, 9.

- **Step 1 — Monitor inbox.** Gmail/IMAP Trigger (poll ~1 min). IF node: attachment exists AND filename ends `.pdf`? No → Set node `status=ignored`, NoOp/stop. Capture: Sender Name, Sender Email, Subject, Received At into the item.
- **Step 2 — Extract invoice data.** Extract-From-File (PDF→text) → OpenAI/HTTP node (`gpt-4.1-nano`, temp 0, extraction prompt) → Code node `JSON.parse` + normalize to cents + keep Raw AI JSON. Required fields: Vendor Name, Vendor ID, PO Number, Invoice Number, Invoice Date, Due Date, Currency, Net, Tax, Gross, Line Items[], Confidence Score, Extraction Warnings[]. On parse failure → retry once → route to manual.
- **Step 3 — Retrieve PO.** Airtable Search `Purchase_Orders` where `PO Number = {{invoice.poNumber}}`. Return Vendor, PO Number, Line Items, Qty, Unit Price, Total, Currency, Approval Status. Empty result → discrepancy `MISSING_PO` (MAJOR).
- **Step 4 — PO matching (Code, deterministic).** Field-by-field compare (Vendor, PO#, Currency, Line Items, Qty, Unit Price, Net, Tax, Total). Output array `[{field, invoiceValue, poValue, match, delta}]`. All money integer cents; tolerances applied. Write to `Purchase Order Match`.
- **Step 5 — Discrepancy detection (Code).** Map match failures → typed discrepancies with MINOR/MAJOR tags + human-readable summary. Write to `Discrepancy Summary`.
- **Step 6 — Validation logic (Code/Switch).** 0 → Ready for Payment; only MINOR → Procurement Review; any MAJOR → Rejected. Set `Validation Status`.
- **Step 7 — Store invoice.** Airtable Create/Update `Invoices`: all extracted fields, PO reference, match result, discrepancy report, status, confidence, **PDF attachment**, email metadata, Raw AI JSON, Received At, Last Updated.
- **Step 8 — Procurement review.** Airtable view "Needs Review" (Status = Procurement Review). Reviewer edits Reviewer Comments + Override + sets `Action`. (The grid *is* the UI.)
- **Step 9 — Approval workflow.** Second n8n workflow: Airtable Trigger / poll on `Action`. Approve → Status Ready for Payment + `Approved At` + audit entry. Reject → Status Rejected + `Rejection Reason` + audit entry.

---

## 4. SAMPLE DATA (build in Phase 1)

**3 POs** in `Purchase_Orders` (choose distinct vendors/currencies):
- `PO-1001` — Acme Office Supplies, USD, 2 line items, Total $1,200.00, Approved.
- `PO-1002` — Globex Hardware, USD, 3 line items, Total $8,450.00, Approved.
- `PO-1003` — Initech Software, EUR, 1 line item, Total €5,000.00, Approved.

**6–7 invoice PDFs** in `sample-data/invoices/`, each engineered to hit one outcome (record all in `EXPECTED_OUTCOMES.md`):
1. `INV-clean-PO1001.pdf` — perfect match → **Ready for Payment**.
2. `INV-withinTol-PO1002.pdf` — total off by +1.2% (within ±2%) → **Ready for Payment** (proves tolerance).
3. `INV-qtymismatch-PO1002.pdf` — one line qty differs → MINOR → **Procurement Review**.
4. `INV-taxwrong-PO1001.pdf` — tax miscalculated beyond rounding tol → MINOR/MAJOR per config → **Review/Rejected**.
5. `INV-overPO-PO1003.pdf` — total exceeds PO by 15% → MAJOR → **Rejected**.
6. `INV-nopo-PO9999.pdf` — PO number not in Airtable → MISSING_PO MAJOR → **Rejected**.
7. `INV-duplicate-PO1001.pdf` — same Invoice # as #1 → **Duplicate** (bonus).
- Plus error probes: `not-an-invoice.pdf` (a random PDF) and `corrupt.pdf` (truncated) for the error-handling demo.

---

## 5. TEST PLAN — run order to demonstrate every outcome

Run invoices **in this order** on video and in the final test pass; each proves a distinct capability:

| # | File | Proves | Expected Status |
|---|------|--------|-----------------|
| 1 | INV-clean-PO1001 | happy path, extraction, attach, store | Ready for Payment |
| 2 | INV-withinTol-PO1002 | ±2% tolerance band | Ready for Payment |
| 3 | INV-qtymismatch-PO1002 | quantity discrepancy → minor | Procurement Review |
| 4 | INV-overPO-PO1003 | total exceeds PO → major + multi-currency | Rejected |
| 5 | INV-nopo-PO9999 | missing PO handling | Rejected |
| 6 | INV-duplicate-PO1001 | duplicate detection (bonus) | Duplicate (skipped) |
| 7 | not-an-invoice / corrupt | error handling & resilience | logged, no crash |
| 8 | (review #3 in Airtable) | HITL approve → audit trail | Ready for Payment |
| 9 | (review, reject one) | HITL reject → reason recorded | Rejected |

Confirm each result against `EXPECTED_OUTCOMES.md` before recording.

---

## 6. DEMO VIDEO — script / shot-list (target 7–8 min)

Record at 1080p, narrate. Have the workflow, Airtable, and inbox pre-opened in tabs. Reset the `Invoices` table before recording.

1. **(0:00–0:45) Intro & architecture.** One sentence on the problem; show the n8n canvas; state the key design decision — *"the LLM extracts facts only; all pass/fail decisions are deterministic JavaScript, so they're auditable and testable."*
2. **(0:45–1:30) Ingestion (Step 1).** Show the procurement inbox; send/point to invoice #1 email; show the Gmail/IMAP trigger firing; note metadata captured; show a non-PDF being ignored.
3. **(1:30–2:45) AI extraction (Step 2).** Open the LLM node; show the prompt (temp 0); show the returned VALID JSON with confidence + warnings; show normalization to cents.
4. **(2:45–3:30) PO retrieval (Step 3).** Show the Airtable `Purchase_Orders` lookup returning PO-1001.
5. **(3:30–5:00) Matching + discrepancy (Steps 4–5).** Walk the field-by-field comparison JSON; run invoice #2 (tolerance pass), #3 (qty → Review), #4 (over PO → Rejected), #5 (missing PO). Show the Discrepancy Summary each time.
6. **(5:00–6:00) DB updates + bands (Steps 6–7).** Show the `Invoices` grid: rows landing in Ready for Payment / Procurement Review / Rejected, with PDF attachments and Raw AI JSON.
7. **(6:00–7:00) HITL approval (Steps 8–9).** In the "Needs Review" view, add a reviewer comment, approve one (→ Ready for Payment, timestamp, audit entry), reject one (→ Rejected + reason). Show the Audit_Log.
8. **(7:00–7:45) Error handling + bonuses.** Feed corrupt/non-invoice PDF → graceful log, no crash; show duplicate detection catching invoice #6; mention tolerance/multi-currency/Slack.
9. **(7:45–8:00) Wrap.** Recap the auditable-decision design and point to the public GitHub repo.

Keep it under 10 min hard. If long, cut shot 8's narration, not the substance.

---

## 7. DELIVERABLES CHECKLIST (mapped to submission form)

- [ ] **n8n workflow JSON export** → `workflows/po-matching-main.json` (+ `po-approval.json`, `error-handler.json`). Export via n8n *Download*, not copy-paste.
- [ ] **Source / repo** → public GitHub repo, clean history, this plan + all folders.
- [ ] **README** → setup, env vars, workflow explanation, assumptions, "facts-only LLM / deterministic decisions" design note, how to import the workflow.
- [ ] **AI prompts** → `prompts/ai_prompts.md (Prompt 1)` (facts-only, JSON schema) + `prompts/02_validation_notes.md` (documents that validation is deterministic JS, with the discrepancy MINOR/MAJOR map + tolerance config). *(Rename/replace the stale resume-task prompt files.)*
- [ ] **DB schema** → `docs/SCHEMA.md` (both tables, field types, single-selects, attachment fields).
- [ ] **Sample data** → `sample-data/invoices/*.pdf`, `sample-data/pos.csv` (or Airtable export), `sample-data/EXPECTED_OUTCOMES.md`.
- [ ] **Demo video** → 5–10 min, uploaded to YouTube (unlisted+public link) or Drive.
- [ ] **Architecture** → `docs/ARCHITECTURE.md` (diagram + node-by-node).

**Submission hygiene:** open every link (GitHub, Drive, YouTube) in an **incognito window** to confirm it's public/accessible. Set GitHub repo to Public; YouTube to Unlisted or Public (not Private); Drive to "Anyone with the link — Viewer". Double-check the workflow JSON has **no embedded secrets** before pushing (n8n export strips credentials, but grep the file for `sk-ant`, `pat`, passwords to be sure).

---

## 8. RISK / BUFFER PLAN

**MUST be done (non-negotiable core — this is the pass/fail spine):**
1. Walking skeleton: email → extract → store record with PDF attachment (Phases 2).
2. Deterministic PO matching + at least **4 discrepancy types** (Missing PO, Quantity, Unit-price/Total-over-PO, Tax) with field-by-field output (Phases 3–4).
3. Three validation bands writing correct status to Airtable (Phase 4).
4. HITL approve/reject with audit timestamp (Phase 5).
5. Basic error handling: non-JSON LLM + missing PO handled without crashing (Phase 6).
6. README + schema + prompts + workflow JSON + demo video (Phases 8–9).

**Cut first if time runs short (in this order):**
1. OCR for scanned invoices — drop entirely.
2. Three-way match (GRN) — drop.
3. Slack/Teams notifications — drop (mention as "future work").
4. Multi-currency beyond a simple currency-equality guard — keep the guard, drop conversion.
5. Extra discrepancy types beyond the core 4 (Additional/Missing line items) — nice-to-have.
6. Second dedicated Audit_Log table — fall back to Airtable revision history + an append-only text field.

**Buffer discipline:**
- End each phase by exporting JSON + committing, so a failed later phase never loses working state.
- If any phase overruns by >50%, stop, ship the working slice, and pull from the cut list rather than pushing the deadline.
- Reserve the final 5h (Phase 9) as untouchable — recording + making links public always takes longer than expected. Do a dry-run of the demo once before the real take.
