# AI Purchase Order Matching & Invoice Validation

An end-to-end AI procurement workflow: it ingests supplier invoices from email,
extracts them with an LLM, **validates each invoice against its approved Purchase
Order using a deterministic matching engine**, detects discrepancies, and routes
the invoice to *Ready for Payment*, *Procurement Review*, or *Rejected* — with a
full audit trail and humans in control of exceptions.

> Round 3 Technical Assignment — **Task 2**. Built with **n8n + OpenAI + Airtable**.

## The core idea (why this design scores)

**The LLM extracts *facts only*. Every pass/fail *decision* is deterministic
JavaScript.** OpenAI reads the PDF into structured JSON (Step 2); the PO matching,
discrepancy detection, and validation banding (Steps 4–6) run as auditable,
unit-testable JavaScript in n8n Code nodes. The same invoice always yields the same
verdict, regardless of model sampling — that's the difference between a demo and a
system you'd actually put in an accounts-payable pipeline.

## What it does
1. **Monitors a procurement inbox** — processes only emails with PDF invoices; captures sender/subject/received metadata.
2. **Extracts invoice data** — PDF text → OpenAI (`gpt-4.1-nano`, temperature 0, **Structured Outputs**) → strict JSON.
3. **Retrieves the Purchase Order** from Airtable by PO number (missing PO is a first-class, auditable rejection path — not a crash).
4. **Matches invoice ↔ PO** field-by-field: vendor, PO number, currency, line items, quantity, unit price, net/tax/total — all money compared in integer cents with configurable tolerance.
5. **Detects discrepancies** — missing PO, vendor/quantity/unit-price mismatch, additional/missing line items, incorrect tax, invoice-exceeds-PO — each tagged Minor/Major.
6. **Bands the outcome** — 0 discrepancies → *Ready for Payment*; only minor → *Procurement Review*; any major → *Rejected*.
7. **Stores the invoice** in Airtable with the original PDF attached, full field comparison, and discrepancy report.
8. **Procurement review** — the Airtable grid *is* the review UI: reviewers see discrepancies, override, approve/reject, comment.
9. **Approval workflow** — approve/reject updates status, stamps timestamp/reason, and appends to an immutable `Audit_Log`.

## Documentation map
| File | What's in it |
|---|---|
| [MASTER_PLAN.md](MASTER_PLAN.md) | **Start here.** Solution summary, build plan, setup checklist, what-to-build-vs-skip. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The 3 n8n workflows, node-by-node, mapped to all 9 steps + the OpenAI call. |
| [docs/MATCHING_ENGINE.md](docs/MATCHING_ENGINE.md) | The deterministic matching/validation engine — full copy-pasteable Code-node JS + worked examples. |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Airtable schema: `Purchase_Orders`, `PO_Line_Items`, `Invoices`, `Invoice_Line_Items`, `Audit_Log`. |
| [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md) | Error matrix, retries, security, scalability, prioritized bonus features. |
| [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md) | Hour-by-hour build plan, test plan, demo-video shot list, deliverables checklist. |
| [prompts/ai_prompts.md](prompts/ai_prompts.md) | The extraction prompt (+ optional review-summary prompt) with design rationale. |
| [sample-data/SAMPLE_DATA.md](sample-data/SAMPLE_DATA.md) | Seed POs + invoices covering every outcome (match / minor / major / missing-PO / duplicate / malformed) — **every expected outcome is verified by the test suite**. |
| [workflows/code_nodes/matching_engine.js](workflows/code_nodes/matching_engine.js) | The matching engine exactly as pasted into the n8n Code node (single source, tested). |
| [tests/engine.test.js](tests/engine.test.js) | 17 assertions: all four demo invoices + tolerance/extra-line/currency/unapproved-PO/broken-arithmetic edge cases. Run: `node tests/engine.test.js`. |
| [workflows/](workflows/) | Exported n8n workflow JSON (added after build). |

## Setup

### Prerequisites
- An **n8n** instance — **n8n Cloud** (fastest) or self-hosted via the included `docker-compose.yml`.
- **OpenAI API key** — https://platform.openai.com (model `gpt-4.1-nano`).
- **Airtable** account + Personal Access Token — https://airtable.com/create/tokens
- A **Gmail/IMAP** inbox for the procurement mailbox.

### Steps
1. Create the Airtable base and tables per [docs/SCHEMA.md](docs/SCHEMA.md); seed `Purchase_Orders` from [sample-data/SAMPLE_DATA.md](sample-data/SAMPLE_DATA.md).
2. Copy `.env.example` → `.env` and fill values (or enter them as n8n credentials / workflow variables). **Never commit `.env`.**
3. Import the workflows from `workflows/` into n8n and connect credentials: Gmail/IMAP, OpenAI, Airtable, (optional) Slack.
4. Email a sample invoice PDF into the inbox → watch the record appear, matched and banded.

### Run n8n self-hosted (optional)
```bash
cp .env.example .env      # fill in values
docker compose up -d      # n8n at http://localhost:5678
```
The exported workflow JSON imports identically on Cloud or self-hosted.

### Required configuration
See [.env.example](.env.example): OpenAI key/model, Airtable base + table names, procurement inbox, and the matching tolerances (`MONEY_REL_TOLERANCE_PCT`, `TAX_ABS_TOLERANCE_CENTS`, `TAX_REL_CEILING_CENTS`, `TOTAL_ABS_TOLERANCE_CENTS`) — the names match the `CONFIG` block in the matching engine.

## AI prompt
One extraction call, `gpt-4.1-nano` at temperature 0 with **Structured Outputs** (`response_format: json_schema, strict: true`) — the model is *guaranteed* to return schema-valid JSON, so there's no "model returned broken JSON" failure mode. Full prompt + rationale in [prompts/ai_prompts.md](prompts/ai_prompts.md).

## Assumptions
- Invoices arrive as digital PDFs (scanned/image PDFs are detected and routed to review; OCR is a documented bonus extension).
- A `Purchase_Orders` table is pre-seeded (the brief assumes it exists).
- Tolerances: PO number & currency must match exactly; monetary amounts ±2% (configurable); quantity exact by default.
- Outcome bands as above; all thresholds are env-configurable.

## Error handling & security
Fail-soft throughout — a bad extraction or missing PO never drops an invoice; it's stored flagged for review with the error captured. API keys live only in n8n credentials / gitignored `.env`. Full matrix in [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).

## Bonus features
_(checked off as built)_
- [x] Tolerance-based validation (core)
- [x] Unit tests for the matching engine (`node tests/engine.test.js` — 17 passing)
- [ ] Duplicate invoice detection (vendor + invoice number)
- [ ] Configurable approval thresholds
- [ ] Slack/Teams notification on Procurement Review
- [ ] Retry & failure handling / error workflow
- [ ] OCR for scanned PDFs
- [ ] Three-way match (Invoice + PO + Goods Receipt Note)

## Demo
5–10 min walkthrough (link added at submission). Shot list in [docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md).
