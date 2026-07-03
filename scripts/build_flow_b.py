#!/usr/bin/env python3
"""Generate workflows/flow_b_approval.json — importable n8n workflow.

Flow B: procurement approval / status finalization (Steps 8-9).
Schedule Trigger (every minute; also runs on manual Execute) → find Invoices
where a reviewer set Approval Decision to Approve/Reject but it isn't finalized
yet (Approval Timestamp blank) → apply the decision → update Validation Status
+ stamp timestamp → append an Audit_Log entry.

Re-run after edits: python3 scripts/build_flow_b.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_ID = "appAcDIn6VkCTnRKW"

# records where a decision was made but not yet finalized
FORMULA = ('AND(OR({Approval Decision}="Approve",{Approval Decision}="Reject"),'
           '{Approval Timestamp}=BLANK())')

CODE_SPLIT = r"""
// Emit one item per pending-decision record (empty -> flow ends cleanly).
const out = [];
for (const it of $input.all()) {
  for (const r of (it.json.records || [])) out.push({ json: r });
}
return out;
"""

CODE_DECIDE = r"""
// Decide the new status from the reviewer's Approval Decision.
const r = $json;
const f = r.fields || {};
const decision = f['Approval Decision'];
const approve = decision === 'Approve';
const newStatus = approve ? 'Ready for Payment' : 'Rejected';
const now = new Date().toISOString();

const fields = {
  'Validation Status': newStatus,
  'Approval Timestamp': now,
  'Approved By': f['Approved By'] || 'procurement@demo',
};
if (!approve) fields['Rejection Reason'] = f['Rejection Reason'] || 'Rejected by procurement reviewer';

return { json: {
  recordId: r.id,
  fields,
  invoiceNumber: f['Invoice Number'] || 'UNKNOWN',
  fromStatus: f['Validation Status'] || '-',
  toStatus: newStatus,
  decision,
  actor: fields['Approved By'],
  comments: f['Reviewer Comments'] || '',
  now,
} };
"""


def node(name, ntype, tv, params, pos, **extra):
    n = {"name": name, "type": ntype, "typeVersion": tv, "parameters": params,
         "position": pos, "id": name.lower().replace(" ", "-")}
    n.update(extra)
    return n


def code_node(name, js, pos, mode="runOnceForEachItem", **extra):
    return node(name, "n8n-nodes-base.code", 2, {"mode": mode, "jsCode": js.strip()}, pos, **extra)


def http_airtable(name, method, url_expr, body_expr, pos, **extra):
    p = {"method": method, "url": url_expr,
         "authentication": "predefinedCredentialType",
         "nodeCredentialType": "airtableTokenApi", "options": {}}
    if body_expr:
        p.update({"sendBody": True, "specifyBody": "json", "jsonBody": body_expr})
    return node(name, "n8n-nodes-base.httpRequest", 4.2, p, pos, **extra)


X = 0
def px():
    global X
    X += 260
    return [X, 300]


nodes = [
    node("Every Minute", "n8n-nodes-base.scheduleTrigger", 1.2,
         {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}}, px()),

    http_airtable("Find Pending Decisions", "GET",
        ("=https://api.airtable.com/v0/" + BASE_ID +
         "/Invoices?filterByFormula={{ encodeURIComponent('" + FORMULA + "') }}"),
        None, px(), retryOnFail=True, maxTries=3, waitBetweenTries=2000),

    code_node("Split Decisions", CODE_SPLIT, px(), mode="runOnceForAllItems"),

    code_node("Decide Status", CODE_DECIDE, px()),

    http_airtable("Update Invoice Status", "PATCH",
        "=https://api.airtable.com/v0/" + BASE_ID + "/Invoices/{{ $json.recordId }}",
        "={{ JSON.stringify({ fields: $json.fields, typecast: true }) }}",
        px(), retryOnFail=True, maxTries=3, waitBetweenTries=2000),

    http_airtable("Audit Log Decision", "POST",
        "=https://api.airtable.com/v0/" + BASE_ID + "/Audit_Log",
        ("={{ JSON.stringify({ records: [{ fields: { "
         "'Entry': $('Decide Status').item.json.invoiceNumber + ' · ' + ($('Decide Status').item.json.decision === 'Approve' ? 'approved' : 'rejected'), "
         "'Invoice Number': $('Decide Status').item.json.invoiceNumber, "
         "'Action': 'Procurement ' + $('Decide Status').item.json.decision, "
         "'Actor': $('Decide Status').item.json.actor, "
         "'From Status': $('Decide Status').item.json.fromStatus, "
         "'To Status': $('Decide Status').item.json.toStatus, "
         "'Timestamp': $('Decide Status').item.json.now, "
         "'Note': $('Decide Status').item.json.comments } }], typecast: true }) }}"),
        px()),
]

connections = {
    "Every Minute":            {"main": [[{"node": "Find Pending Decisions", "type": "main", "index": 0}]]},
    "Find Pending Decisions":  {"main": [[{"node": "Split Decisions", "type": "main", "index": 0}]]},
    "Split Decisions":         {"main": [[{"node": "Decide Status", "type": "main", "index": 0}]]},
    "Decide Status":           {"main": [[{"node": "Update Invoice Status", "type": "main", "index": 0}]]},
    "Update Invoice Status":   {"main": [[{"node": "Audit Log Decision", "type": "main", "index": 0}]]},
}

workflow = {
    "name": "Flow B - PO Approval Status Updater",
    "nodes": nodes,
    "connections": connections,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
}

out = os.path.join(ROOT, "workflows", "flow_b_approval.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(workflow, f, indent=2)
print(f"wrote {out} ({os.path.getsize(out)} bytes, {len(nodes)} nodes)")
