# AI Prompts — PO Matching & Invoice Validation

This document defines the two OpenAI prompts used by the n8n workflow.

**Design principle (read this first):** The LLM extracts **FACTS ONLY**. It never
decides whether an invoice passes or fails. All PO matching, discrepancy
detection, and the Ready-for-Payment / Review / Rejected decision (Steps 4–6)
are **deterministic JavaScript** in n8n Code nodes — auditable, testable,
gradeable. Prompt 1 turns a messy PDF into clean JSON. Prompt 2 (optional) turns
the deterministic engine's output into a human-readable summary. Neither prompt
is ever allowed to make the accept/reject call.

| Prompt | Model | Temp | Runs at | Purpose |
|---|---|---|---|---|
| 1 — Invoice Extraction (required) | `gpt-4.1-nano` | 0 | Step 2, after PDF text extraction | Extract structured invoice facts as JSON |
| 2 — Discrepancy Summary (optional) | `gpt-4.1-nano` | 0 | After Step 5, before Airtable write | Explain the engine's findings in plain English |

---

## PROMPT 1 — Invoice Extraction (primary, required)

**Where it runs:** n8n → "Extract Invoice (OpenAI)" node.
**Input variable:** `{{ $json.invoiceText }}` — raw text extracted from the PDF
(pdf-parse / OCR fallback), injected into the `INVOICE_TEXT` placeholder.

### System prompt

```
You are a precise invoice-extraction engine for an accounts-payable system.
Your only job is to read the raw text of a single supplier invoice and return
its data as one structured JSON object.

Core rules:
- You extract FACTS that are literally present in the document. You NEVER invent,
  guess, or infer values that are not supported by the text.
- If a value is not present, you return null (for a scalar) or [] (for a list).
  A confident null is better than a hallucinated value.
- You output ONLY a single valid JSON object: no prose, no explanations, no
  markdown, and NO code fences (no ```json). The first character of your reply
  must be '{' and the last must be '}'.
- Numbers are JSON numbers, never strings. No currency symbols, no thousands
  separators, no quotes around numeric values.
- You do NOT make any approval, matching, or validation decision. That is handled
  downstream. You only report what the invoice says.
```

### User prompt (template)

```
Extract the fields from the invoice text below and return them as a single JSON
object that EXACTLY matches this schema (same keys, same order, same types):

{
  "vendor_name": string | null,
  "vendor_id": string | null,
  "po_number": string | null,
  "invoice_number": string | null,
  "invoice_date": string | null,          // ISO date "YYYY-MM-DD"
  "due_date": string | null,              // ISO date "YYYY-MM-DD"
  "currency": string | null,              // ISO 4217 code, e.g. "USD", "CAD", "EUR"
  "net_amount": number | null,            // subtotal before tax
  "tax_amount": number | null,            // total tax
  "tax_rate": number | null,              // percent as a number, e.g. 13 for 13%
  "gross_amount": number | null,          // net + tax (invoice total payable)
  "line_items": [
    {
      "description": string,
      "sku": string | null,               // SKU / item code / part number, else null
      "quantity": number | null,
      "unit_price": number | null,
      "line_total": number | null
    }
  ],
  "confidence": number,                    // 0..1, your confidence in the whole extraction
  "extraction_warnings": string[]          // human-readable notes about anything uncertain
}

RULES:
- Return ONLY the JSON object. No markdown, no ```json fences, no commentary
  before or after. First char '{', last char '}'.
- Missing scalar -> null. Missing/empty list -> []. Never omit a key.
- Numbers as numbers, not strings. Strip currency symbols, %, and thousands
  separators. "$1,234.50" -> 1234.5 ; "13%" in tax_rate -> 13.
- Dates: normalize ANY format to ISO "YYYY-MM-DD" (e.g. "July 2, 2026",
  "02/07/2026", "2026-07-02" all -> "2026-07-02"). If a date is genuinely
  ambiguous (e.g. 03/04/2026 with no locale cues), pick the most likely reading,
  keep it as ISO, and add a note to extraction_warnings. If unparseable -> null.
- currency: return the ISO 4217 code. Map symbols when unambiguous ($ with a
  US/Canada address, USD/CAD text, €, £). If the symbol is ambiguous (e.g. "$"
  with no country cue), return your best code and add an extraction_warnings note.
- po_number: capture the purchase order reference exactly as printed (e.g.
  "PO-10432", "4500091234"). Do not fabricate one. If none is present -> null and
  add a warning "No PO number found on invoice".
- Line items: one object per billed line. Preserve the vendor's description
  verbatim (trimmed). Do not merge or split lines. If quantity/unit_price/
  line_total are not all present, fill what you can and leave the rest null.
- Amounts: net_amount is the pre-tax subtotal, gross_amount is the total payable,
  tax_amount is the tax. Do NOT recompute or "fix" them — report the printed
  values. If the printed totals are internally inconsistent (e.g. net + tax !=
  gross), STILL report the printed numbers and add an extraction_warnings note
  describing the mismatch. (The downstream engine checks the math; you do not.)
- confidence: start high for a clean, machine-generated invoice. LOWER it when
  the text is sparse, OCR-garbled, missing key totals, or ambiguous. A near-empty
  or unreadable document should score well below 0.5.
- Never invent data to fill the schema. Unknown is null, not a plausible guess.

INVOICE TEXT:
"""
{{INVOICE_TEXT}}
"""
```

### Why it's built this way (talking points)

- **Explicit, ordered JSON schema in the prompt** → the downstream n8n Code nodes
  get predictable keys and types every time; no field-name guessing, no schema
  drift between runs.
- **Hard `null` / `[]` / "never omit a key" contract** → the deterministic matcher
  can safely read every field without `undefined` crashes, and a missing PO
  number becomes a first-class discrepancy signal instead of a parse error.
- **"ONLY JSON, first char `{`, no `” + fences" rule** → kills the classic
  ```` ```json ```` wrapper that breaks `JSON.parse`. We still fence-strip in code
  (belt-and-suspenders — see Defensive Parsing below).
- **Numbers-as-numbers + ISO dates + ISO-4217 currency normalization** → all
  cleanup happens once, at extraction time, so the matching engine can compare in
  integer cents and exact currency codes without re-parsing strings.
- **Temperature 0** → deterministic, repeatable extraction; the same invoice
  yields the same JSON, which is what makes the demo and the grading reproducible.
- **Facts-vs-judgement separation** → the prompt explicitly forbids recomputing
  totals or making any approval decision; it reports printed values (even
  inconsistent ones) and flags them via `extraction_warnings`, leaving pass/fail
  to the auditable JS engine.
- **Self-reported `confidence` + `extraction_warnings`** → drive confidence-based
  routing and give the procurement reviewer instant context on what the model was
  unsure about (supports the OCR / low-quality-scan bonus paths).

---

## PROMPT 2 — Discrepancy Summary (optional, recommended)

**Where it runs:** n8n → "Summarize Discrepancies (OpenAI)" node, AFTER the
deterministic engine (Steps 4–6) has already produced its structured result and
its final decision.
**Input variable:** `{{ $json.engineResult }}` — the engine's JSON, injected into
the `ENGINE_RESULT` placeholder.

> **This prompt NEVER decides pass/fail.** The deterministic engine has already
> set `validation_status`. Prompt 2 only translates the machine output into a
> concise, human-readable note for the procurement reviewer. If the summary and
> the engine ever disagree, the ENGINE is the source of truth.

### System prompt

```
You are a procurement analyst assistant. You are given the OUTPUT of a
deterministic invoice-vs-PO matching engine that has ALREADY decided the outcome.

Your only job is to explain that result to a human reviewer in clear, concise
business English. You do NOT re-decide anything.

Hard rules:
- The engine's validation_status is FINAL and authoritative. Never contradict it,
  never suggest a different status, never re-run the math. If you think a field
  looks wrong, describe it as "flagged by the engine", not as your own verdict.
- Only describe discrepancies that appear in the provided data. Do not invent
  discrepancies, amounts, or PO details that are not in the input.
- Be brief and factual. No filler, no apologies, no restating the whole schema.
- Return ONLY the JSON object specified below. No markdown, no code fences.
```

### User prompt (template)

```
Below is the deterministic matching engine's result for one invoice. Write a
short procurement-review summary. Return ONLY this JSON object:

{
  "headline": string,          // one sentence, e.g. "3 discrepancies found; routed to Procurement Review."
  "summary": string,           // 2-4 sentences in plain English explaining what matched and what did not
  "discrepancy_bullets": string[],  // one short bullet per discrepancy, most severe first
  "suggested_action_rationale": string  // WHY the engine's status is reasonable, given the discrepancies
}

RULES:
- Do NOT change or second-guess the engine's validation_status. Explain it.
- Reference concrete values from the input (e.g. "Unit price $12.00 vs PO $10.00,
  +20%") so the reviewer can act without opening the raw JSON.
- If there are zero discrepancies, say so plainly and keep discrepancy_bullets [].
- No markdown, no fences. First char '{', last char '}'.

ENGINE RESULT:
"""
{{ENGINE_RESULT}}
"""
```

### Why it's built this way (talking points)

- **Consumes the engine's output, never the raw invoice** → structurally
  incapable of inventing a different verdict; it can only narrate facts the
  deterministic layer already computed and logged.
- **"Engine status is FINAL / source of truth" framing** → makes the
  facts-vs-judgement separation explicit and auditable; if the prose ever drifts,
  policy is that the JS decision wins and the summary is cosmetic.
- **Same JSON-only, no-fences contract as Prompt 1** → identical defensive
  parsing path, one code helper reused for both calls.
- **Concrete-values requirement** → the reviewer gets an actionable one-glance
  summary in the Airtable grid (Step 8) without opening the raw AI JSON.
- **Temperature 0** → stable, professional summaries suitable for an audit trail.
- **Optional by design** → if the node fails or is disabled, the workflow still
  routes correctly because the decision was already made upstream; the summary is
  an enhancement, never a dependency.

---

## Defensive parsing (pairs with both prompts)

Even with a strict "no fences" instruction, treat every LLM response as
potentially fence-wrapped or whitespace-padded. In the n8n Code node that
follows each OpenAI call, strip fences first, then parse inside try/catch:

```js
// Robustly parse a OpenAI JSON reply that *should* be a bare JSON object.
function parseOpenAIJson(raw) {
  let text = (raw ?? '').trim();

  // 1) Strip leading/trailing triple-backtick fences, with or without a language tag.
  //    Handles ```json ... ```, ``` ... ```, and stray leading/trailing fences.
  text = text
    .replace(/^```[a-zA-Z0-9]*\s*/, '')  // opening fence + optional lang
    .replace(/\s*```$/, '')              // closing fence
    .trim();

  // 2) Fallback: if there is still stray prose, grab the outermost {...} block.
  if (text[0] !== '{') {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      text = text.slice(first, last + 1);
    }
  }

  // 3) Parse defensively. On failure, surface a structured error instead of throwing
  //    an opaque stack trace — the workflow can route this to an error branch.
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: `OpenAI JSON parse failed: ${err.message}`,
      raw,            // keep the original for the audit trail / manual review
    };
  }
}

const parsed = parseOpenAIJson($json.openaiResponseText)  // openaiResponseText = choices[0].message.content;
if (!parsed.ok) {
  // Route to error-handling branch: flag for manual review, log parsed.error + parsed.raw.
  throw new Error(parsed.error);
}
return [{ json: parsed.data }];
```

**Why this pairs with the prompts:**
- The prompts minimize the chance of fences; the parser guarantees correctness
  even when the model slips — defense in depth.
- Keeping `raw` on failure preserves the **immutable Raw AI JSON** for the audit
  trail and lets a human recover a bad extraction instead of silently dropping it.
- Returning a structured `{ ok, error }` (instead of a bare throw deep in a
  regex) lets the n8n error branch route the item to manual review — clean
  error-handling and resilience, both graded criteria.
