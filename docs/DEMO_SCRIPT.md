# Demo Video Script — Speak-Along Edition (target ≈ 8 min)

Every scene has **🖱 DO** (exactly what to click) and **🎤 SAY** (read it aloud,
or paraphrase). Practice once without recording; the whole thing is ~8 minutes.

---

## 0. BEFORE YOU RECORD — prep checklist (10 min, not on camera)

1. **Re-import the latest Flow A** (it contains the hardened engine + duplicate
   detection): n8n → Workflows → Import from file →
   `workflows/flow_a_ingest_match.json` → assign the 7 credentials
   (OpenAI Extract → OpenAI key; Check Duplicate / Find PO / Create Invoice Record /
   Upload PDF Attachment / Audit Log Entry / Log Duplicate → Airtable PAT) →
   delete the older Flow A copy.
2. **Clean the stage:** in Airtable, delete all rows in `Invoices` and `Audit_Log`
   (keep `Purchase_Orders`!). Delete leftover `Table 1` if still there.
3. **Pre-send one email** so Scene 5 has no dead air: send `invoice_A.pdf`
   (from `sample-data/pdfs/`) to the procurement inbox, subject
   `Invoice INV-NW-4501`. It'll be waiting when you hit Execute.
4. **Open these tabs in order:** ① GitHub repo → ② n8n Flow A → ③ n8n Flow B →
   ④ Airtable base (Invoices tab) → ⑤ Gmail (personal, to send more invoices).
5. **Recorder:** QuickTime → File → New Screen Recording (record the full screen,
   1080p). Mic on. Do a 5-second test.

---

## Scene 1 — Opening (30 s) · *tab: GitHub README*

**🖱 DO:** Sit on the repo README, top of page.

**🎤 SAY:**
> "Hi, I'm Shubham. This is my Task 2 submission — an AI-powered Purchase Order
> matching and invoice validation workflow, built with n8n, OpenAI, and Airtable.
> Supplier invoices arrive by email; the system extracts them with an LLM,
> validates them against the approved Purchase Order, detects discrepancies, and
> routes each invoice to Ready for Payment, Procurement Review, or Rejected —
> with a full audit trail.
>
> The core design decision: **the LLM extracts facts only. Every pass-or-fail
> decision is deterministic JavaScript** — unit-tested, auditable, and the same
> invoice always gets the same verdict. There is no LLM in the payment decision."

---

## Scene 2 — Repo & tests (40 s) · *tab: GitHub*

**🖱 DO:** Scroll the README slowly past the "9 required steps" table. Then open
`tests/engine.test.js` briefly.

**🎤 SAY:**
> "The repo has everything: both workflow exports, the matching engine as a
> standalone tested file, the Airtable schema, the AI prompts with rationale,
> and sample purchase orders and invoices covering every outcome.
> The matching engine has a test suite — twenty-four assertions covering perfect
> matches, tax errors, quantity mismatches, missing POs, and adversarial edge
> cases like manipulated line totals and missing amounts. An invoice with
> unreadable totals can never auto-approve."

*(Optional flex: run `node tests/engine.test.js` in a terminal on camera — 5 s.)*

---

## Scene 3 — The data model (30 s) · *tab: Airtable*

**🖱 DO:** Click through the three table tabs: Purchase_Orders → Invoices (empty) → Audit_Log (empty).

**🎤 SAY:**
> "In Airtable: the Purchase_Orders table is the source of truth — three approved
> POs across three vendors and currencies, with line items, quantities, and unit
> prices. The Invoices table is where validated invoices land — and this grid
> doubles as the procurement review UI. And Audit_Log is an append-only trail of
> every state change. Both are empty — everything you'll see now happens live."

---

## Scene 4 — Flow A tour (60 s) · *tab: n8n Flow A*

**🖱 DO:** Show the canvas; move the cursor along the nodes left → right as you talk.

**🎤 SAY:**
> "Flow A is the ingestion pipeline — twenty-one nodes. A Gmail trigger polls the
> procurement inbox and only passes emails with PDF attachments — everything else
> is explicitly ignored. We capture the sender, subject, and received time, extract
> the PDF's text layer, and send it to OpenAI — gpt-4.1-nano at temperature zero,
> with **Structured Outputs**, which guarantees schema-valid JSON back. No broken-JSON
> failure mode.
>
> Then: a duplicate check — if this invoice number already exists we skip and log it.
> Then we fetch the Purchase Order from Airtable, and here —" *(hover the Matching
> Engine node)* "— is the heart of the system: a deterministic matching engine.
> Six hundred lines of tested JavaScript comparing vendor, PO number, currency,
> line items, quantities, unit prices, and totals — all in integer cents with a
> configurable two-percent tolerance. Its verdict drives everything downstream:
> the record, the PDF attachment, and the audit entry."

---

## Scene 5 — LIVE: perfect match → Ready for Payment (90 s)

**🖱 DO:**
1. (Email was pre-sent in prep.) In n8n Flow A, click **Execute workflow**.
2. Watch nodes go green. When done, switch to **Airtable → Invoices**.
3. Open the new **INV-NW-4501** row (expand). Point at: Purchase Order Match =
   *Matched*, Discrepancy Severity = *None*, Validation Status = **Ready for
   Payment**, the attached PDF, Sender Email, Received At.

**🎤 SAY (while nodes run):**
> "I've emailed a clean invoice from Northwind for exactly what PO-2001 approved.
> Executing… the trigger picks up the email, extracts the PDF, OpenAI returns the
> structured data, we find PO-2001, and the engine compares every field."

**🎤 SAY (on the record):**
> "And here's the record: every field extracted, matched to the PO, zero
> discrepancies — **Ready for Payment**. The original PDF is attached, sender and
> timestamp captured, and the full field-by-field comparison is stored as JSON
> right on the record."

---

## Scene 6 — LIVE: bad invoice → Rejected (60 s)

**🖱 DO:**
1. Gmail tab: send `invoice_C.pdf` to the inbox, subject `Invoice CIC-88231`.
2. **Count ~20 seconds** (talk through the next SAY block — it covers the wait).
3. n8n → Execute workflow → Airtable → open **CIC-88231** → point at the
   **Discrepancy Summary**.

**🎤 SAY (during the wait):**
> "Now the interesting case — a supplier over-billing. This invoice references
> PO-2002, but bills eighty bearings where fifty were approved, raised a unit
> price by seventeen percent, and the total exceeds the approved PO value by
> almost fifty percent."

**🎤 SAY (on the record):**
> "The engine caught all of it: quantity mismatch, unit-price mismatch, net
> exceeds PO, invoice exceeds PO — four major discrepancies, each with the exact
> numbers and deltas — **Rejected**. And note this is deterministic logic, not an
> LLM's opinion: same invoice, same verdict, every time."

---

## Scene 7 — LIVE: missing PO + duplicate detection (60 s)

**🖱 DO:**
1. Send `invoice_D.pdf` (subject `Invoice INV-NW-4599`) → wait ~20 s → Execute.
   Show the new row: Purchase Order Match = *No Match* → **Rejected**.
2. Now **re-send `invoice_A.pdf`** → wait ~20 s → Execute.
3. Show: **no new row** in Invoices; switch to **Audit_Log** → point at the
   `INV-NW-4501 · duplicate skipped` entry.

**🎤 SAY:**
> "Two edge cases. First: an invoice referencing PO-9999 — a purchase order that
> doesn't exist. That's not a crash; it's a first-class business outcome: missing
> PO, major, **Rejected**, fully logged.
>
> Second: I'm re-sending the very first invoice — same invoice number. The
> workflow detects the duplicate, refuses to create a second payable record, and
> writes a 'duplicate skipped' entry to the audit log instead. No double payment."

---

## Scene 8 — LIVE: human review + approval, Flow B (75 s)

**🖱 DO:**
1. Send `invoice_B.pdf` (subject `Invoice HPT-2026-0342`) → wait ~20 s → Execute
   Flow A. Open the new row: Validation Status = **Procurement Review**, one minor
   `incorrect_tax_calculation` in the summary.
2. In the row: set **Approval Decision → Approve**, type in **Reviewer Comments**:
   `Tax rounding acceptable — approved`.
3. Switch to **n8n Flow B** tab → **Execute workflow**.
4. Back to Airtable: the row now shows **Ready for Payment** + Approval Timestamp.
5. Open **Audit_Log**: point at the approval entry (from-status → to-status, actor, note).

**🎤 SAY:**
> "Last scenario — the human-in-the-loop. This German supplier's invoice matches
> its PO on every line, but the VAT is mis-computed by seven euros sixty. That's
> not fraud — it's a small tax error — so the engine classifies it as a *minor*
> discrepancy and routes it to **Procurement Review** instead of auto-rejecting.
>
> The Airtable grid is the review UI. As the reviewer, I read the discrepancy,
> decide it's acceptable, set the decision to Approve, and add a comment.
> Flow B picks that up —" *(execute)* "— the status flips to Ready for Payment
> with a timestamp and my identity recorded… and the audit log now shows the
> complete lifecycle: ingested by the system, approved by procurement — who,
> when, from which status to which, and why."

---

## Scene 9 — Error handling & wrap (45 s) · *tab: n8n Flow A canvas*

**🖱 DO:** Point at the *Ignored – No PDF* and *Needs OCR – Scanned PDF* branches,
then the retry badge on OpenAI Extract.

**🎤 SAY:**
> "On resilience: emails without PDFs are explicitly ignored; scanned PDFs with no
> text layer take a dedicated branch; every external call retries three times with
> backoff; and the engine's core safety rule is that missing data never
> auto-approves — an invoice with unreadable amounts always goes to a human.
>
> So — all nine required steps: inbox monitoring, AI extraction, PO retrieval,
> field-by-field matching, discrepancy detection, validation rules, storage with
> the original PDF, procurement review, and an approval workflow with a complete
> audit trail. Plus duplicate detection, tolerance-based validation, retries, and
> a twenty-four-assertion test suite as bonuses. Everything is in the repo, with
> setup instructions to run it end to end. Thanks for watching."

**🖱 DO:** Stop recording. 🎬

---

## After recording
1. Watch it once. Re-record a single scene if needed (or just re-record all — it's 8 min).
2. Upload: **YouTube → Unlisted** (or Google Drive → Share → *Anyone with the link*).
3. **Open the link in an incognito window** to verify access.
4. Paste the link into README §"Demo video", commit, push.
5. Submit the Google Form with the GitHub link + video link.
6. **After submitting:** rotate the OpenAI key, remove `schema.bases:write` from the Airtable PAT.
