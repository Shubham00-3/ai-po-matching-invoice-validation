#!/usr/bin/env python3
"""Render the sample invoices from sample-data/SAMPLE_DATA.md into real PDFs.

Zero dependencies: writes minimal single-page PDFs with a Courier text layer
(monospace preserves the ASCII invoice layout, and the text layer is exactly
what n8n's Extract From File node reads). Output: sample-data/pdfs/invoice_X.pdf
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD = open(os.path.join(ROOT, "sample-data", "SAMPLE_DATA.md"), encoding="utf-8").read()
OUT_DIR = os.path.join(ROOT, "sample-data", "pdfs")
os.makedirs(OUT_DIR, exist_ok=True)


def esc(line):
    """Escape PDF string specials; degrade non-latin-1 chars gracefully."""
    line = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    return line.encode("latin-1", "replace").decode("latin-1")


def text_to_pdf(text, path):
    lines = text.rstrip("\n").split("\n")
    content = ["BT", "/F1 9 Tf", "10.8 TL", "36 806 Td"]
    for ln in lines:
        content.append(f"({esc(ln)}) Tj T*")
    content.append("ET")
    stream = "\n".join(content).encode("latin-1")

    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] "
                b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>")
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")
    objs.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs)+1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\n"
            f"startxref\n{xref_pos}\n%%EOF\n").encode()
    open(path, "wb").write(bytes(out))


# pull each "### Invoice X" section's first fenced text block (the invoice document)
sections = re.findall(r"### Invoice ([A-F])[^\n]*\n(.*?)(?=### Invoice [A-F]|## \d|\Z)", MD, re.S)
made = []
for label, body in sections:
    m = re.search(r"\n```\n(.*?)```", body, re.S)
    if not m:
        continue
    text = m.group(1)
    # skip blocks that are JSON (expected-output blocks are ```json, but be safe)
    if text.lstrip().startswith("{") or text.lstrip().startswith("["):
        continue
    path = os.path.join(OUT_DIR, f"invoice_{label}.pdf")
    text_to_pdf(text, path)
    made.append((label, os.path.getsize(path)))

for label, size in made:
    print(f"invoice_{label}.pdf  {size} bytes")
print(f"\n{len(made)} PDFs written to {OUT_DIR}")
