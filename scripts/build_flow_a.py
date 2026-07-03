#!/usr/bin/env python3
"""Generate workflows/flow_a_ingest_match.json — importable n8n workflow.

Flow A: Gmail Trigger → filter PDF → extract text → OpenAI (Structured Outputs)
→ find PO in Airtable → deterministic matching engine → create Invoice record
→ upload PDF attachment → append Audit_Log entry.

The matching-engine Code node embeds workflows/code_nodes/matching_engine.js
verbatim, so the tested file stays the single source of truth.
Re-run after any engine/prompt change: python3 scripts/build_flow_a.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_ID = "appAcDIn6VkCTnRKW"

ENGINE = open(os.path.join(ROOT, "workflows", "code_nodes", "matching_engine.js"), encoding="utf-8").read()

SYSTEM_PROMPT = (
    "You are a precise invoice-data extraction engine. You read raw text extracted "
    "from a supplier invoice PDF and return structured data. Rules: extract ONLY "
    "what is present in the text - never invent or guess values; use null for any "
    "scalar you cannot find and [] for empty lists; numbers must be plain numbers "
    "(no currency symbols or thousands separators); dates must be ISO YYYY-MM-DD; "
    "currency must be the ISO-4217 code (CAD, USD, EUR...); tax_rate is the percent "
    "as a number (13 for 13%). Set confidence_score (0..1) lower when the document "
    "is sparse, garbled, or ambiguous, and add a short note to extraction_warnings "
    "for anything unusual (unreadable fields, math that does not add up, missing PO)."
)

INVOICE_SCHEMA = {
    "name": "invoice_extraction",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "vendor_name": {"type": ["string", "null"]},
            "vendor_id": {"type": ["string", "null"]},
            "purchase_order_number": {"type": ["string", "null"]},
            "invoice_number": {"type": ["string", "null"]},
            "invoice_date": {"type": ["string", "null"], "description": "ISO YYYY-MM-DD"},
            "due_date": {"type": ["string", "null"], "description": "ISO YYYY-MM-DD"},
            "currency": {"type": ["string", "null"], "description": "ISO-4217 code"},
            "net_amount": {"type": ["number", "null"]},
            "tax_amount": {"type": ["number", "null"]},
            "tax_rate": {"type": ["number", "null"], "description": "percent, e.g. 13"},
            "gross_amount": {"type": ["number", "null"]},
            "line_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "sku": {"type": ["string", "null"]},
                        "description": {"type": ["string", "null"]},
                        "quantity": {"type": ["number", "null"]},
                        "unit_price": {"type": ["number", "null"]},
                        "line_total": {"type": ["number", "null"]},
                    },
                    "required": ["sku", "description", "quantity", "unit_price", "line_total"],
                },
            },
            "confidence_score": {"type": "number"},
            "extraction_warnings": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["vendor_name", "vendor_id", "purchase_order_number", "invoice_number",
                     "invoice_date", "due_date", "currency", "net_amount", "tax_amount",
                     "tax_rate", "gross_amount", "line_items", "confidence_score",
                     "extraction_warnings"],
    },
}

# ---------------------------------------------------------------- Code nodes
CODE_EMAIL_META = r"""
// Step 1 - capture email metadata + normalize the PDF attachment to binary key "data".
// Robust to both n8n's normalized Gmail output AND the raw Gmail API format
// (Simplify OFF), where From/Subject/Date live in payload.headers[{name,value}].
const item = $input.item;
const j = item.json || {};
const bin = item.binary || {};

// find first PDF attachment regardless of its property name (attachment_0, ...)
const pdfKey = Object.keys(bin).find(k =>
  (bin[k].mimeType || '').toLowerCase().includes('pdf') ||
  (bin[k].fileName || '').toLowerCase().endsWith('.pdf'));

// header lookup across raw (payload.headers array) and normalized shapes
const headers = j.payload?.headers || j.headers || [];
const getHeader = (name) => {
  let v = null;
  if (Array.isArray(headers)) {
    const h = headers.find(x => (x.name || '').toLowerCase() === name.toLowerCase());
    v = h ? h.value : null;
  } else if (headers && typeof headers === 'object') {
    v = headers[name] ?? headers[name.toLowerCase()] ?? null;
  }
  if (typeof v === 'string') v = v.replace(new RegExp('^' + name + '\\s*:\\s*', 'i'), '').trim();
  return v || null;
};

const fromStr = j.from?.text || (typeof j.from === 'string' ? j.from : null) || getHeader('From') || j.From || '';
const senderEmail = j.from?.value?.[0]?.address || (fromStr.match(/[\w.+-]+@[\w.-]+/) || [null])[0];
const senderName = j.from?.value?.[0]?.name
  || (fromStr.includes('<') ? fromStr.split('<')[0].replace(/"/g, '').trim() : null)
  || senderEmail;
const subject = j.subject || getHeader('Subject') || j.Subject || '';

let receivedAt;
if (j.date) receivedAt = new Date(j.date).toISOString();
else if (j.internalDate) receivedAt = new Date(Number(j.internalDate)).toISOString();
else { const d = getHeader('Date'); receivedAt = d ? new Date(d).toISOString() : new Date().toISOString(); }

const out = {
  hasPdf: Boolean(pdfKey),
  senderName: senderName || null,
  senderEmail: senderEmail || null,
  subject,
  receivedAt,
  messageId: j.id || j.messageId || null,
  pdfFilename: pdfKey ? (bin[pdfKey].fileName || 'invoice.pdf') : null,
};
if (!pdfKey) return { json: out };
return { json: out, binary: { data: bin[pdfKey] } };
"""

CODE_BUILD_REQUEST = r"""
// Step 2 - assemble the OpenAI Chat Completions body (Structured Outputs, temp 0).
const SYSTEM_PROMPT = __SYSTEM_PROMPT__;
const RESPONSE_FORMAT = { type: 'json_schema', json_schema: __INVOICE_SCHEMA__ };

const pdfText = ($json.text || '').slice(0, 60000); // safety cap
return { json: { openaiBody: {
  model: 'gpt-4.1-nano',
  temperature: 0,
  max_tokens: 2000,
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: 'Extract this invoice into the JSON schema.\n\n===== INVOICE TEXT START =====\n' + pdfText + '\n===== INVOICE TEXT END =====' },
  ],
  response_format: RESPONSE_FORMAT,
} } };
"""

CODE_PARSE = r"""
// Step 2b - parse the model output and map to the engine's invoice contract.
const raw = $json.choices?.[0]?.message?.content ?? '';
let text = String(raw).trim();
// defensive fence strip (Structured Outputs should make this a no-op)
text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'').trim();
let x;
try { x = JSON.parse(text); }
catch (e) { throw new Error('EXTRACTION_JSON_INVALID: ' + e.message); }

const invoice = {
  vendorName: x.vendor_name, vendorId: x.vendor_id,
  poNumber: x.purchase_order_number ?? x.po_number ?? null,
  invoiceNumber: x.invoice_number,
  invoiceDate: x.invoice_date, dueDate: x.due_date,
  currency: x.currency,
  netAmount: x.net_amount, taxAmount: x.tax_amount,
  taxRatePct: x.tax_rate ?? x.tax_rate_pct ?? null,
  grossAmount: x.gross_amount,
  lineItems: (x.line_items || []).map(li => ({
    sku: li.sku, description: li.description, quantity: li.quantity,
    unitPrice: li.unit_price, lineTotal: li.line_total,
  })),
  confidenceScore: x.confidence_score ?? x.confidence ?? null,
  extractionWarnings: x.extraction_warnings || [],
};
const meta = $('Email Metadata').item.json;
return { json: { invoice, meta, rawAi: text } };
"""

CODE_PREPARE_MATCH = r"""
// Step 3 - map the Airtable PO record (or absence) to the engine's PO contract.
const inv = $('Parse Extraction').item.json;
const rec = ($json.records || [])[0];
let po;
if (!rec) {
  po = { _notFound: true };
} else {
  const f = rec.fields || {};
  let lines = [];
  try { lines = JSON.parse(f['Line Items JSON'] || '[]'); } catch (e) { /* engine flags missing lines */ }
  po = {
    vendorName: f['Vendor Name'], vendorId: f['Vendor ID'], poNumber: f['PO Number'],
    currency: f['Currency'], approvalStatus: f['Approval Status'],
    netTotal: f['Net Amount'], taxTotal: f['Tax Amount'], grossTotal: f['Total Amount'],
    totalIsGross: true, expectedTaxRatePct: f['Expected Tax Rate Pct'],
    lineItems: lines.map(li => ({
      sku: li.sku, description: li.description, quantity: li.quantity,
      unitPrice: li.unit_price, lineTotal: li.line_total,
    })),
    _recordId: rec.id,
  };
}
return { json: { invoice: inv.invoice, po, meta: inv.meta, rawAi: inv.rawAi } };
"""

CODE_FORMAT_FIELDS = r"""
// Steps 4-7 output - map engine result + context to Airtable Invoices fields.
const eng = $json;   // matching-engine output
const ctx = $('Prepare Match Input').item.json;
const inv = ctx.invoice, meta = ctx.meta;

const noMatch = (eng.discrepancies || []).some(d => d.type === 'missing_po' || d.type === 'wrong_po');
const fields = {
  'Invoice Number': inv.invoiceNumber || 'UNKNOWN',
  'Vendor Name': inv.vendorName || '',
  'Vendor ID': inv.vendorId || '',
  'PO Number': inv.poNumber || '',
  'Invoice Date': inv.invoiceDate || undefined,
  'Due Date': inv.dueDate || undefined,
  'Currency': inv.currency || undefined,
  'Net Amount': inv.netAmount ?? undefined,
  'Tax Amount': inv.taxAmount ?? undefined,
  'Gross Amount': inv.grossAmount ?? undefined,
  'Tax Rate Pct': inv.taxRatePct ?? undefined,
  'Line Items JSON': JSON.stringify(inv.lineItems || [], null, 2),
  'Purchase Order Match': noMatch ? 'No Match' : (eng.severity === 'none' ? 'Matched' : 'Partial'),
  'Field Comparisons': JSON.stringify(eng.fieldComparisons || [], null, 2),
  'Discrepancy Summary': (eng.discrepancies || [])
      .map(d => `[${d.severity}] ${d.type}: ${d.message}`).join('\n') || 'None',
  'Discrepancy Severity': eng.severity === 'none' ? 'None' : (eng.severity === 'minor' ? 'Minor' : 'Major'),
  'Confidence Score': inv.confidenceScore ?? undefined,
  'Extraction Warnings': (inv.extractionWarnings || []).join('\n'),
  'Validation Status': eng.validationStatus,
  'Approval Decision': 'Pending',
  'Sender Email': meta.senderEmail || undefined,
  'Email Subject': meta.subject || '',
  'Received At': meta.receivedAt || undefined,
  'Raw AI JSON': ctx.rawAi || '',
};
Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);
return { json: { fields, matchSummary: eng.matchSummary, validationStatus: eng.validationStatus } };
"""

# ---------------------------------------------------------------- helpers
def node(name, ntype, tv, params, pos, **extra):
    n = {"name": name, "type": ntype, "typeVersion": tv, "parameters": params,
         "position": pos, "id": name.lower().replace(" ", "-").replace("&", "and")}
    n.update(extra)
    return n

def code_node(name, js, pos, **extra):
    return node(name, "n8n-nodes-base.code", 2,
                {"mode": "runOnceForEachItem", "jsCode": js.strip()}, pos, **extra)

def http_airtable(name, method, url_expr, body_expr, pos, **extra):
    p = {
        "method": method,
        "url": url_expr,
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "airtableTokenApi",
        "options": {},
    }
    if body_expr:
        p.update({"sendBody": True, "specifyBody": "json", "jsonBody": body_expr})
    return node(name, "n8n-nodes-base.httpRequest", 4.2, p, pos, **extra)

build_request_js = (CODE_BUILD_REQUEST
                    .replace("__SYSTEM_PROMPT__", json.dumps(SYSTEM_PROMPT))
                    .replace("__INVOICE_SCHEMA__", json.dumps(INVOICE_SCHEMA)))

# ---------------------------------------------------------------- nodes
X = 0
def px():
    global X
    X += 240
    return [X, 300]

nodes = [
    node("Gmail Trigger", "n8n-nodes-base.gmailTrigger", 1.2, {
        "pollTimes": {"item": [{"mode": "everyMinute"}]},
        "simple": False,
        "filters": {"q": "has:attachment filename:pdf"},
        "options": {"downloadAttachments": True, "dataPropertyAttachmentsPrefixName": "attachment_"},
    }, px()),

    code_node("Email Metadata", CODE_EMAIL_META, px()),

    node("Has PDF?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "combinator": "and",
            "conditions": [{
                "leftValue": "={{ $json.hasPdf }}",
                "rightValue": "true",
                "operator": {"type": "boolean", "operation": "true", "singleValue": True},
            }],
        },
    }, px()),

    node("Extract PDF Text", "n8n-nodes-base.extractFromFile", 1, {
        "operation": "pdf", "binaryPropertyName": "data", "options": {},
    }, px()),

    node("Has Text Layer?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "combinator": "and",
            "conditions": [{
                "leftValue": "={{ ($json.text || '').trim().length }}",
                "rightValue": 30,
                "operator": {"type": "number", "operation": "gt"},
            }],
        },
    }, px()),

    code_node("Build OpenAI Request", build_request_js, px()),

    node("OpenAI Extract", "n8n-nodes-base.httpRequest", 4.2, {
        "method": "POST",
        "url": "https://api.openai.com/v1/chat/completions",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "openAiApi",
        "sendBody": True, "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.openaiBody) }}",
        "options": {"timeout": 120000},
    }, px(), retryOnFail=True, maxTries=3, waitBetweenTries=2000),

    code_node("Parse Extraction", CODE_PARSE, px()),

    http_airtable("Check Duplicate", "GET",
        ("=https://api.airtable.com/v0/" + BASE_ID + "/Invoices"
         "?maxRecords=1&filterByFormula={{ encodeURIComponent('{Invoice Number}=\"' + (($('Parse Extraction').item.json.invoice.invoiceNumber || '').replace(/\"/g, '')) + '\"') }}"),
        None, px(), retryOnFail=True, maxTries=3, waitBetweenTries=2000),

    node("Is Duplicate?", "n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
            "combinator": "and",
            "conditions": [{
                "leftValue": "={{ ($json.records || []).length }}",
                "rightValue": 0,
                "operator": {"type": "number", "operation": "gt"},
            }],
        },
    }, px()),

    http_airtable("Find PO", "GET",
        ("=https://api.airtable.com/v0/" + BASE_ID + "/Purchase_Orders"
         "?filterByFormula={{ encodeURIComponent('{PO Number}=\"' + (($('Parse Extraction').item.json.invoice.poNumber || '').replace(/\"/g, '')) + '\"') }}"),
        None, px(), retryOnFail=True, maxTries=3, waitBetweenTries=2000),

    code_node("Prepare Match Input", CODE_PREPARE_MATCH, px()),

    code_node("Matching Engine", ENGINE, px()),

    code_node("Format Airtable Fields", CODE_FORMAT_FIELDS, px()),

    http_airtable("Create Invoice Record", "POST",
        "=https://api.airtable.com/v0/" + BASE_ID + "/Invoices",
        "={{ JSON.stringify({ records: [{ fields: $json.fields }], typecast: true }) }}",
        px(), retryOnFail=True, maxTries=3, waitBetweenTries=2000),

    http_airtable("Upload PDF Attachment", "POST",
        ("=https://content.airtable.com/v0/" + BASE_ID +
         "/{{ $json.records[0].id }}/Invoice%20Attachment/uploadAttachment"),
        ("={{ JSON.stringify({ contentType: 'application/pdf', "
         "filename: $('Email Metadata').item.json.pdfFilename || 'invoice.pdf', "
         "file: $('Email Metadata').item.binary.data.data }) }}"),
        px(), onError="continueRegularOutput"),

    http_airtable("Audit Log Entry", "POST",
        "=https://api.airtable.com/v0/" + BASE_ID + "/Audit_Log",
        ("={{ JSON.stringify({ records: [{ fields: { "
         "'Entry': ($('Format Airtable Fields').item.json.fields['Invoice Number']) + ' · ingested', "
         "'Invoice Number': $('Format Airtable Fields').item.json.fields['Invoice Number'], "
         "'Action': 'Invoice ingested, extracted and validated', "
         "'Actor': 'system:n8n', "
         "'From Status': '-', "
         "'To Status': $('Format Airtable Fields').item.json.validationStatus, "
         "'Timestamp': $now.toISO(), "
         "'Note': $('Format Airtable Fields').item.json.matchSummary } }], typecast: true }) }}"),
        px()),

    node("Ignored - No PDF", "n8n-nodes-base.noOp", 1, {}, [3 * 240, 520]),
    node("Needs OCR - Scanned PDF", "n8n-nodes-base.noOp", 1, {}, [5 * 240, 520]),

    http_airtable("Log Duplicate", "POST",
        "=https://api.airtable.com/v0/" + BASE_ID + "/Audit_Log",
        ("={{ JSON.stringify({ records: [{ fields: { "
         "'Entry': ($('Parse Extraction').item.json.invoice.invoiceNumber || 'UNKNOWN') + ' · duplicate skipped', "
         "'Invoice Number': $('Parse Extraction').item.json.invoice.invoiceNumber, "
         "'Action': 'Duplicate invoice detected — no new record created', "
         "'Actor': 'system:n8n', "
         "'From Status': '-', "
         "'To Status': 'Duplicate', "
         "'Timestamp': $now.toISO(), "
         "'Note': 'An invoice with this number already exists (record ' + (($json.records||[])[0] ? $json.records[0].id : '?') + ').' } }], typecast: true }) }}"),
        [9 * 240, 520]),

    node("Duplicate Skipped", "n8n-nodes-base.noOp", 1, {}, [10 * 240, 520]),
]

connections = {
    "Gmail Trigger":          {"main": [[{"node": "Email Metadata", "type": "main", "index": 0}]]},
    "Email Metadata":         {"main": [[{"node": "Has PDF?", "type": "main", "index": 0}]]},
    "Has PDF?":               {"main": [[{"node": "Extract PDF Text", "type": "main", "index": 0}],
                                        [{"node": "Ignored - No PDF", "type": "main", "index": 0}]]},
    "Extract PDF Text":       {"main": [[{"node": "Has Text Layer?", "type": "main", "index": 0}]]},
    "Has Text Layer?":        {"main": [[{"node": "Build OpenAI Request", "type": "main", "index": 0}],
                                        [{"node": "Needs OCR - Scanned PDF", "type": "main", "index": 0}]]},
    "Build OpenAI Request":   {"main": [[{"node": "OpenAI Extract", "type": "main", "index": 0}]]},
    "OpenAI Extract":         {"main": [[{"node": "Parse Extraction", "type": "main", "index": 0}]]},
    "Parse Extraction":       {"main": [[{"node": "Check Duplicate", "type": "main", "index": 0}]]},
    "Check Duplicate":        {"main": [[{"node": "Is Duplicate?", "type": "main", "index": 0}]]},
    "Is Duplicate?":          {"main": [[{"node": "Log Duplicate", "type": "main", "index": 0}],
                                        [{"node": "Find PO", "type": "main", "index": 0}]]},
    "Log Duplicate":          {"main": [[{"node": "Duplicate Skipped", "type": "main", "index": 0}]]},
    "Find PO":                {"main": [[{"node": "Prepare Match Input", "type": "main", "index": 0}]]},
    "Prepare Match Input":    {"main": [[{"node": "Matching Engine", "type": "main", "index": 0}]]},
    "Matching Engine":        {"main": [[{"node": "Format Airtable Fields", "type": "main", "index": 0}]]},
    "Format Airtable Fields": {"main": [[{"node": "Create Invoice Record", "type": "main", "index": 0}]]},
    "Create Invoice Record":  {"main": [[{"node": "Upload PDF Attachment", "type": "main", "index": 0}]]},
    "Upload PDF Attachment":  {"main": [[{"node": "Audit Log Entry", "type": "main", "index": 0}]]},
}

workflow = {
    "name": "Flow A - PO Ingest Extract Match Store",
    "nodes": nodes,
    "connections": connections,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
}

out = os.path.join(ROOT, "workflows", "flow_a_ingest_match.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(workflow, f, indent=2)
print(f"wrote {out} ({os.path.getsize(out)} bytes, {len(nodes)} nodes)")
