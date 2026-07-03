# Demo Video Script (5–10 min)

A scene-by-scene shot list. Everything is already set up — you're just narrating
and clicking. Keep it calm; the system does the talking. Total ≈ 7 minutes.

> **Before you hit record:** have these tabs open — (1) the GitHub repo,
> (2) n8n with Flow A open, (3) n8n with Flow B open, (4) Airtable Procurement
> base, (5) Gmail (the demo inbox). Clear the Invoices/Audit_Log tables if you
> want a clean run, or keep existing rows and just add new ones.

---

## Scene 1 — What it is (30s)
> "This is an AI-powered Purchase Order matching and invoice validation workflow,
> built with n8n, OpenAI, and Airtable. Supplier invoices arrive by email; the
> system extracts them, validates each against its approved Purchase Order, detects
> discrepancies, and routes it to Ready for Payment, Procurement Review, or
> Rejected — with a human in control of exceptions and a full audit trail."

**The one line that sells it:**
> "The key design decision: the LLM only extracts *facts*. Every pass/fail
> *decision* is deterministic JavaScript — so the same invoice always gets the same
> verdict, and every decision is auditable. No LLM in the decision path."

## Scene 2 — The repo & architecture (45s)
- Show the **GitHub README** — scroll the "What it does" list and the docs map.
- Open **docs/ARCHITECTURE.md**, show the Flow A / Flow B diagram.
- Mention: "17-passing unit-test suite on the matching engine — `tests/engine.test.js`."

## Scene 3 — The data model (30s)
- Airtable → **Purchase_Orders**: "Three approved POs seeded — the source of truth."
- **Invoices**: "Where validated invoices land — this grid *is* the procurement
  review UI." **Audit_Log**: "Append-only trail of every state change."

## Scene 4 — Flow A walkthrough (60s)
- n8n → Flow A canvas. Trace left to right:
  > "Gmail trigger → capture metadata → confirm it's a PDF → extract the text →
  > send it to OpenAI with Structured Outputs for guaranteed-valid JSON → check for
  > duplicates → look up the PO in Airtable → the deterministic matching engine →
  > discrepancy detection → validation banding → store the record and attach the PDF
  > → write an audit entry."

## Scene 5 — LIVE run: a clean invoice → Ready for Payment (90s)
- Gmail: send **invoice_A.pdf** to the inbox (subject `Invoice INV-NW-4501`).
- **Wait ~20 seconds** (say "giving Gmail a moment to receive it").
- n8n → **Execute workflow**. Watch nodes go green left to right.
- Airtable → Invoices → open the new **INV-NW-4501** row:
  > "Matched to PO-2001, zero discrepancies → **Ready for Payment**. PDF attached,
  > sender and timestamp captured."

## Scene 6 — A bad invoice → Rejected (60s)
- Show (or send) **invoice_C.pdf** → open **CIC-88231**:
  > "Same vendor's PO-2002, but quantity is 80 vs the approved 50, unit price is off,
  > and the total exceeds the PO. Four major discrepancies → **Rejected**. The
  > Discrepancy Summary spells out exactly why."
- Optionally show **invoice_D** (**INV-NW-4599**): "References PO-9999, which doesn't
  exist → **Rejected**, missing PO — a first-class path, not a crash."

## Scene 7 — Duplicate detection (30s)
- Re-send **invoice_A.pdf** → Execute again.
  > "Same invoice number already exists — so instead of creating a duplicate payable,
  > it logs a 'duplicate skipped' entry to the audit log. No double payment."
- Show the **Audit_Log** `INV-NW-4501 · duplicate skipped` row.

## Scene 8 — Human review + approval, Flow B (75s)
- Show **HPT-2026-0342** (invoice B): "One minor discrepancy — the supplier
  mis-computed VAT — so it's flagged **Procurement Review**, not auto-rejected."
- In Airtable set **Approval Decision → Approve**, add a Reviewer Comment.
- n8n → **Flow B** → **Execute workflow**.
- Back to the record: "Status flips to **Ready for Payment**, timestamped, with the
  reviewer recorded."
- Open **Audit_Log**: "And the full lifecycle is here — ingested, then approved by
  procurement — who, when, from which status to which."

## Scene 9 — Error handling (30s)
- On the Flow A canvas, point to the branches:
  > "Fail-soft throughout: no PDF → ignored; a scanned image with no text → flagged
  > for OCR; malformed AI output → the invoice is still saved for manual review, never
  > silently dropped. Retries with backoff on every external call."

## Scene 10 — Wrap (20s)
> "That's all nine required steps — email ingestion, AI extraction, PO matching,
> discrepancy detection, validation, storage, procurement review, approval, and a
> complete audit trail — with duplicate detection and tests as bonuses. Code and
> docs are in the linked repo. Thanks for watching."

---

### Recording tips
- QuickTime (Mac) → File → New Screen Recording is fine. 1080p.
- Do a dry run once without recording so the ~20s email waits don't feel awkward.
- If a Gmail wait drags, pause and resume, or pre-send the email before that scene.
- Upload to YouTube **unlisted** (or Google Drive with link-sharing **on**) and make
  sure the link opens in an incognito window before submitting.
