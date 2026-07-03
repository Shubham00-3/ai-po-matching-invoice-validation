// Tests for the deterministic PO-matching engine (workflows/code_nodes/matching_engine.js).
// The engine is an n8n Code-node script (top-level return, reads $json), so we wrap it
// in a Function the same way n8n does. Run: node tests/engine.test.js
const fs = require('fs');
const path = require('path');

const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'workflows', 'code_nodes', 'matching_engine.js'), 'utf8');
const engine = new Function('$json', engineSrc);
const run = (invoice, po) => {
  const res = engine({ invoice, po });
  return Array.isArray(res) ? res[0].json : res;
};

// ---- fixtures: mirror sample-data/SAMPLE_DATA.md exactly -------------------
const PO_2001 = {
  vendorName: 'Northwind Office Supplies Ltd.', vendorId: 'V-1001', poNumber: 'PO-2001',
  currency: 'CAD', approvalStatus: 'Approved',
  netTotal: 2800.00, taxTotal: 364.00, grossTotal: 3164.00,
  lineItems: [
    { sku: 'NW-PAP-A4', description: 'A4 Premium Paper, 80gsm (case of 5 reams)', quantity: 40, unitPrice: 32.50 },
    { sku: 'NW-TNR-58A', description: 'Toner Cartridge 58A (black)', quantity: 12, unitPrice: 95.00 },
    { sku: 'NW-PEN-BLK', description: 'Gel Pens, black (box of 50)', quantity: 20, unitPrice: 18.00 },
  ],
};
const PO_2002 = {
  vendorName: 'Cascade Industrial Components Inc.', vendorId: 'V-1002', poNumber: 'PO-2002',
  currency: 'USD', approvalStatus: 'Approved',
  netTotal: 2895.00, taxTotal: 0.00, grossTotal: 2895.00,
  lineItems: [
    { sku: 'CI-BRG-608', description: 'Ball Bearing 608ZZ (pack of 100)', quantity: 50, unitPrice: 42.00 },
    { sku: 'CI-BLT-M8', description: 'Hex Bolt M8x40 (pack of 200)', quantity: 30, unitPrice: 26.50 },
  ],
};
const PO_2003 = {
  vendorName: 'Helvetia Precision Tools GmbH', vendorId: 'V-1003', poNumber: 'PO-2003',
  currency: 'EUR', approvalStatus: 'Approved',
  netTotal: 2850.00, taxTotal: 541.50, grossTotal: 3391.50, expectedTaxRatePct: 19,
  lineItems: [
    { sku: 'HP-CAL-150', description: 'Digital Caliper 150mm', quantity: 15, unitPrice: 78.00 },
    { sku: 'HP-MIC-25', description: 'Micrometer 0-25mm', quantity: 10, unitPrice: 132.00 },
    { sku: 'HP-GAU-SET', description: 'Feeler Gauge Set (32 blades)', quantity: 25, unitPrice: 14.40 },
  ],
};

const INV_A = { // perfect match -> Ready for Payment
  vendorName: 'Northwind Office Supplies Ltd.', poNumber: 'PO-2001', invoiceNumber: 'INV-NW-4501',
  invoiceDate: '2026-06-18', dueDate: '2026-07-18', currency: 'CAD',
  netAmount: 2800.00, taxAmount: 364.00, grossAmount: 3164.00, taxRatePct: 13,
  lineItems: [
    { sku: 'NW-PAP-A4', description: 'A4 Premium Paper, 80gsm (case/5)', quantity: 40, unitPrice: 32.50, lineTotal: 1300.00 },
    { sku: 'NW-TNR-58A', description: 'Toner Cartridge 58A (black)', quantity: 12, unitPrice: 95.00, lineTotal: 1140.00 },
    { sku: 'NW-PEN-BLK', description: 'Gel Pens, black (box of 50)', quantity: 20, unitPrice: 18.00, lineTotal: 360.00 },
  ],
  confidenceScore: 0.97, extractionWarnings: [],
};
const INV_B = { // VAT mis-computed by -7.60 -> minor incorrect_tax_calculation -> Procurement Review
  vendorName: 'Helvetia Precision Tools GmbH', poNumber: 'PO-2003', invoiceNumber: 'HPT-2026-0342',
  invoiceDate: '2026-06-20', dueDate: '2026-07-20', currency: 'EUR',
  netAmount: 2850.00, taxAmount: 533.90, grossAmount: 3383.90, taxRatePct: 19,
  lineItems: [
    { sku: 'HP-CAL-150', description: 'Digital Caliper 150mm', quantity: 15, unitPrice: 78.00, lineTotal: 1170.00 },
    { sku: 'HP-MIC-25', description: 'Micrometer 0-25mm', quantity: 10, unitPrice: 132.00, lineTotal: 1320.00 },
    { sku: 'HP-GAU-SET', description: 'Feeler Gauge Set (32 blades)', quantity: 25, unitPrice: 14.40, lineTotal: 360.00 },
  ],
  confidenceScore: 0.96, extractionWarnings: [],
};
const INV_C = { // qty 80 vs 50, price 31.00 vs 26.50, total exceeds PO -> Rejected
  vendorName: 'Cascade Industrial Components Inc.', poNumber: 'PO-2002', invoiceNumber: 'CIC-77812',
  currency: 'USD', netAmount: 4290.00, taxAmount: 0.00, grossAmount: 4290.00, taxRatePct: 0,
  lineItems: [
    { sku: 'CI-BRG-608', description: 'Ball Bearing 608ZZ (pack of 100)', quantity: 80, unitPrice: 42.00, lineTotal: 3360.00 },
    { sku: 'CI-BLT-M8', description: 'Hex Bolt M8x40 (pack of 200)', quantity: 30, unitPrice: 31.00, lineTotal: 930.00 },
  ],
  confidenceScore: 0.95, extractionWarnings: [],
};
const INV_D = { // references PO-9999 which does not exist -> Rejected (missing_po)
  vendorName: 'Northwind Office Supplies Ltd.', poNumber: 'PO-9999', invoiceNumber: 'INV-NW-4507',
  currency: 'CAD', netAmount: 325.00, taxAmount: 42.25, grossAmount: 367.25, taxRatePct: 13,
  lineItems: [{ sku: 'NW-PAP-A4', description: 'A4 Premium Paper', quantity: 10, unitPrice: 32.50, lineTotal: 325.00 }],
  confidenceScore: 0.97, extractionWarnings: [],
};

// ---- tiny assert harness ---------------------------------------------------
let failures = 0;
function expect(name, actual, want) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${ok ? '' : `(got ${JSON.stringify(actual)}, want ${JSON.stringify(want)})`}`);
  if (!ok) failures++;
}

// ---- demo-scenario tests (must mirror sample-data/SAMPLE_DATA.md) ----------
let r = run(INV_A, PO_2001);
expect('A: status', r.validationStatus, 'Ready for Payment');
expect('A: no discrepancies', r.discrepancies.length, 0);

r = run(INV_B, PO_2003);
expect('B: status', r.validationStatus, 'Procurement Review');
expect('B: counts', [r.meta.counts.major, r.meta.counts.minor], [0, 1]);
expect('B: type', r.discrepancies[0].type, 'incorrect_tax_calculation');

r = run(INV_C, PO_2002);
expect('C: status', r.validationStatus, 'Rejected');
expect('C: has quantity_mismatch', r.discrepancies.some(d => d.type === 'quantity_mismatch'), true);
expect('C: has unit_price_mismatch', r.discrepancies.some(d => d.type === 'unit_price_mismatch'), true);
expect('C: has invoice_exceeds_po', r.discrepancies.some(d => d.type === 'invoice_exceeds_po'), true);

r = run(INV_D, { _notFound: true });
expect('D: status', r.validationStatus, 'Rejected');
expect('D: type', r.discrepancies[0].type, 'missing_po');

// ---- edge-case tests --------------------------------------------------------
// within-tolerance price variance (+1%) passes clean
const invTol = JSON.parse(JSON.stringify(INV_A));
invTol.lineItems[0].unitPrice = 32.80; invTol.lineItems[0].lineTotal = 1312.00;
invTol.netAmount = 2812.00; invTol.taxAmount = 365.56; invTol.grossAmount = 3177.56;
r = run(invTol, PO_2001);
expect('tolerance: +1%% price passes clean', r.validationStatus, 'Ready for Payment');

// additional line item not on PO -> major
const invExtra = JSON.parse(JSON.stringify(INV_A));
invExtra.lineItems.push({ sku: 'NW-XX-1', description: 'Rush Handling Fee', quantity: 1, unitPrice: 250.00, lineTotal: 250.00 });
invExtra.netAmount = 3050.00; invExtra.taxAmount = 396.50; invExtra.grossAmount = 3446.50;
r = run(invExtra, PO_2001);
expect('extra line: rejected', r.validationStatus, 'Rejected');
expect('extra line: type present', r.discrepancies.some(d => d.type === 'additional_line_item'), true);

// currency mismatch -> major
const invCur = JSON.parse(JSON.stringify(INV_A));
invCur.currency = 'USD';
r = run(invCur, PO_2001);
expect('currency mismatch: rejected', r.validationStatus, 'Rejected');

// unapproved PO -> major
const poPending = JSON.parse(JSON.stringify(PO_2001));
poPending.approvalStatus = 'Pending';
r = run(INV_A, poPending);
expect('unapproved PO: rejected', r.validationStatus, 'Rejected');

// broken arithmetic: net + tax != gross -> major
const invIdent = JSON.parse(JSON.stringify(INV_A));
invIdent.grossAmount = 3500.00;
r = run(invIdent, PO_2001);
expect('identity broken: not clean', r.validationStatus === 'Ready for Payment', false);

// ---- regression tests for the missing-amount / line-total / confidence fixes ----

// all amounts null but vendor/PO/lines match -> must NOT auto-approve
const invNoAmounts = JSON.parse(JSON.stringify(INV_A));
invNoAmounts.netAmount = null; invNoAmounts.taxAmount = null; invNoAmounts.grossAmount = null;
r = run(invNoAmounts, PO_2001);
expect('missing all amounts: not Ready for Payment', r.validationStatus !== 'Ready for Payment', true);
expect('missing all amounts: flags missing_data', r.discrepancies.some(d => d.type === 'missing_data'), true);

// missing gross only -> must NOT auto-approve
const invNoGross = JSON.parse(JSON.stringify(INV_A));
invNoGross.grossAmount = null;
r = run(invNoGross, PO_2001);
expect('missing gross: not Ready for Payment', r.validationStatus !== 'Ready for Payment', true);

// line total inconsistent with qty x unit -> major line_total_mismatch
const invBadLine = JSON.parse(JSON.stringify(INV_A));
invBadLine.lineItems[0].lineTotal = 999.00; // qty 40 x 32.50 = 1300, not 999
r = run(invBadLine, PO_2001);
expect('bad line total: rejected', r.validationStatus, 'Rejected');
expect('bad line total: flagged', r.discrepancies.some(d => d.type === 'line_total_mismatch'), true);

// missing confidence score -> not auto-approved (low_confidence minor)
const invNoConf = JSON.parse(JSON.stringify(INV_A));
delete invNoConf.confidenceScore;
r = run(invNoConf, PO_2001);
expect('missing confidence: not Ready for Payment', r.validationStatus !== 'Ready for Payment', true);
expect('missing confidence: flags low_confidence', r.discrepancies.some(d => d.type === 'low_confidence'), true);

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
