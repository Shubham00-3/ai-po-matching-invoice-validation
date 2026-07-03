#!/usr/bin/env python3
"""One-shot Airtable setup for the PO-Matching project.

Creates the three tables (Purchase_Orders, Invoices, Audit_Log) in an existing
empty base and seeds the three sample Purchase Orders from
sample-data/SAMPLE_DATA.md. Idempotent: skips tables/records that already exist.

Line items live in a JSON long-text field (per MASTER_PLAN: relational child
tables are an optional upgrade; the matching engine's coerceLineItems() parses
JSON strings natively).

Usage:
  1. Put AIRTABLE_API_KEY (PAT) and AIRTABLE_BASE_ID in .env
     PAT scopes needed: data.records:read, data.records:write,
                        schema.bases:read, schema.bases:write
  2. python3 scripts/setup_airtable.py
"""
import json
import os
import sys
import urllib.request
import urllib.error

# ---------- config ----------------------------------------------------------
def load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.split("#")[0].strip()
    return env

ENV = load_env()
PAT = os.environ.get("AIRTABLE_API_KEY") or ENV.get("AIRTABLE_API_KEY", "")
BASE = os.environ.get("AIRTABLE_BASE_ID") or ENV.get("AIRTABLE_BASE_ID", "")
if not PAT.startswith("pat") or not BASE.startswith("app"):
    sys.exit("ERROR: set AIRTABLE_API_KEY (pat...) and AIRTABLE_BASE_ID (app...) in .env first.")

API = "https://api.airtable.com/v0"
HEADERS = {"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"}

def call(method, url, payload=None):
    req = urllib.request.Request(url, method=method, headers=HEADERS,
                                 data=json.dumps(payload).encode() if payload else None)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise SystemExit(f"Airtable API error {e.code} on {method} {url}:\n{body}")

# ---------- field-type helpers ----------------------------------------------
def text(name):        return {"name": name, "type": "singleLineText"}
def longtext(name):    return {"name": name, "type": "multilineText"}
def num(name, p=2):    return {"name": name, "type": "number", "options": {"precision": p}}
def email(name):       return {"name": name, "type": "email"}
def date(name):        return {"name": name, "type": "date", "options": {"dateFormat": {"name": "iso"}}}
def datetime(name):    return {"name": name, "type": "dateTime", "options": {
                            "dateFormat": {"name": "iso"}, "timeFormat": {"name": "24hour"},
                            "timeZone": "client"}}
def attach(name):      return {"name": name, "type": "multipleAttachments"}
def select(name, opts):return {"name": name, "type": "singleSelect",
                               "options": {"choices": [{"name": o} for o in opts]}}

CURRENCIES = ["CAD", "USD", "EUR"]

# ---------- schema -----------------------------------------------------------
TABLES = [
    {
        "name": "Purchase_Orders",
        "description": "Approved POs (seeded). Line items as JSON long-text; engine parses natively.",
        "fields": [
            text("PO Number"),                        # primary
            text("Vendor Name"),
            text("Vendor ID"),
            select("Currency", CURRENCIES),
            select("Approval Status", ["Approved", "Pending", "Cancelled"]),
            num("Net Amount"),
            num("Tax Amount"),
            num("Total Amount"),
            num("Expected Tax Rate Pct"),
            longtext("Line Items JSON"),
            date("PO Date"),
            text("Buyer"),
        ],
    },
    {
        "name": "Invoices",
        "description": "Created by Flow A. Grid views = procurement review UI.",
        "fields": [
            text("Invoice Number"),                   # primary
            text("Vendor Name"),
            text("Vendor ID"),
            text("PO Number"),
            date("Invoice Date"),
            date("Due Date"),
            select("Currency", CURRENCIES),
            num("Net Amount"),
            num("Tax Amount"),
            num("Gross Amount"),
            num("Tax Rate Pct"),
            longtext("Line Items JSON"),
            select("Purchase Order Match", ["Matched", "Partial", "No Match"]),
            longtext("Field Comparisons"),
            longtext("Discrepancy Summary"),
            select("Discrepancy Severity", ["None", "Minor", "Major"]),
            num("Confidence Score"),
            longtext("Extraction Warnings"),
            select("Validation Status", ["Ready for Payment", "Procurement Review", "Rejected"]),
            longtext("Reviewer Comments"),
            select("Approval Decision", ["Pending", "Approve", "Reject"]),
            datetime("Approval Timestamp"),
            text("Approved By"),
            longtext("Rejection Reason"),
            text("Assigned To"),
            attach("Invoice Attachment"),
            email("Sender Email"),
            text("Email Subject"),
            datetime("Received At"),
            longtext("Processing Errors"),
            longtext("Raw AI JSON"),
        ],
    },
    {
        "name": "Audit_Log",
        "description": "Append-only trail of every state transition (Step 9).",
        "fields": [
            text("Entry"),                            # primary, e.g. "INV-NW-4501 · created"
            text("Invoice Number"),
            text("Action"),
            text("Actor"),
            text("From Status"),
            text("To Status"),
            datetime("Timestamp"),
            longtext("Note"),
        ],
    },
]

# ---------- seed data (mirrors sample-data/SAMPLE_DATA.md) -------------------
def li(sku, desc, qty, price, total):
    return {"sku": sku, "description": desc, "quantity": qty,
            "unit_price": price, "line_total": total}

SEED_POS = [
    {
        "PO Number": "PO-2001", "Vendor Name": "Northwind Office Supplies Ltd.",
        "Vendor ID": "V-1001", "Currency": "CAD", "Approval Status": "Approved",
        "Net Amount": 2800.00, "Tax Amount": 364.00, "Total Amount": 3164.00,
        "Expected Tax Rate Pct": 13,
        "Line Items JSON": json.dumps([
            li("NW-PAP-A4", "A4 Premium Paper, 80gsm (case of 5 reams)", 40, 32.50, 1300.00),
            li("NW-TNR-58A", "Toner Cartridge 58A (black)", 12, 95.00, 1140.00),
            li("NW-PEN-BLK", "Gel Pens, black (box of 50)", 20, 18.00, 360.00),
        ], indent=2),
    },
    {
        "PO Number": "PO-2002", "Vendor Name": "Cascade Industrial Components Inc.",
        "Vendor ID": "V-1002", "Currency": "USD", "Approval Status": "Approved",
        "Net Amount": 2895.00, "Tax Amount": 0.00, "Total Amount": 2895.00,
        "Expected Tax Rate Pct": 0,
        "Line Items JSON": json.dumps([
            li("CI-BRG-608", "Ball Bearing 608ZZ (pack of 100)", 50, 42.00, 2100.00),
            li("CI-BLT-M8", "Hex Bolt M8x40 (pack of 200)", 30, 26.50, 795.00),
        ], indent=2),
    },
    {
        "PO Number": "PO-2003", "Vendor Name": "Helvetia Precision Tools GmbH",
        "Vendor ID": "V-1003", "Currency": "EUR", "Approval Status": "Approved",
        "Net Amount": 2850.00, "Tax Amount": 541.50, "Total Amount": 3391.50,
        "Expected Tax Rate Pct": 19,
        "Line Items JSON": json.dumps([
            li("HP-CAL-150", "Digital Caliper 150mm", 15, 78.00, 1170.00),
            li("HP-MIC-25", "Micrometer 0-25mm", 10, 132.00, 1320.00),
            li("HP-GAU-SET", "Feeler Gauge Set (32 blades)", 25, 14.40, 360.00),
        ], indent=2),
    },
]

# ---------- run ---------------------------------------------------------------
def main():
    existing = {t["name"] for t in call("GET", f"{API}/meta/bases/{BASE}/tables")["tables"]}
    print(f"Base {BASE}: existing tables: {sorted(existing) or '(none)'}")

    for t in TABLES:
        if t["name"] in existing:
            print(f"  = {t['name']} already exists — skipping create")
        else:
            call("POST", f"{API}/meta/bases/{BASE}/tables", t)
            print(f"  + created {t['name']} ({len(t['fields'])} fields)")

    # seed POs (idempotent by PO Number)
    url = f"{API}/{BASE}/Purchase_Orders"
    have = {r["fields"].get("PO Number") for r in call("GET", url + "?fields%5B%5D=PO+Number").get("records", [])}
    to_add = [{"fields": p} for p in SEED_POS if p["PO Number"] not in have]
    if to_add:
        call("POST", url, {"records": to_add, "typecast": True})
        print(f"  + seeded {len(to_add)} purchase order(s): {[r['fields']['PO Number'] for r in to_add]}")
    else:
        print("  = all 3 sample POs already seeded")

    print("\nDONE. Open the base and verify: Purchase_Orders (3 rows), Invoices (empty), Audit_Log (empty).")

if __name__ == "__main__":
    main()
