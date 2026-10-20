"""Tailor text in the source PDF without rebuilding its layout or contact header."""
import json
import os
from pathlib import Path
import re
import sys

import pymupdf as fitz


def line_text(line):
    return "".join(s["text"] for s in line["spans"]).strip()


def template(doc):
    slots = []
    section = ""
    context = []
    for pi, page in enumerate(doc):
        lines = [l for b in page.get_text("dict")["blocks"] if b["type"] == 0 for l in b["lines"]]
        if not lines:
            continue
        drawings = page.get_drawings()
        bullets = [d["rect"] for d in drawings if 1 < d["rect"].width < 5 and 1 < d["rect"].height < 5]
        current = None
        right = max([l["bbox"][2] for l in lines] + [d["rect"].x1 for d in drawings if d["rect"].width > page.rect.width * 0.6 and d["rect"].height < 2])
        for line in lines:
            text = line_text(line)
            if not text:
                continue
            x0, y0, x1, y1 = line["bbox"]
            heading = text.isupper() and len(text) > 3 and line["spans"][0]["size"] < 14
            bullet = any(abs(b.x1 + 8.2 - x0) < 2 and y0 <= (b.y0 + b.y1) / 2 <= y1 for b in bullets)
            skill = section == "SKILLS & INTERESTS" and ":" in text
            if heading:
                section, context, current = text, [], None
                continue
            editable = bullet or skill or section == "SUMMARY"
            continuation = current is not None and abs(x0 - current["x"]) < 1 and 0 < line["spans"][0]["origin"][1] - current["baselines"][-1] < 15
            if editable and (bullet or skill or current is None):
                current = {
                    "id": f"p{pi + 1}-{len(slots) + 1}", "page": pi,
                    "section": section, "context": " | ".join(context),
                    "text": text, "x": x0, "right": right,
                    "top": y0, "bottom": y1, "size": line["spans"][0]["size"],
                    "baselines": [line["spans"][0]["origin"][1]],
                    "rects": [line["bbox"]],
                }
                slots.append(current)
            elif continuation:
                current["text"] += " " + text
                current["bottom"] = y1
                current["baselines"].append(line["spans"][0]["origin"][1])
                current["rects"].append(line["bbox"])
            else:
                current = None
                context.append(text)
                context = context[-6:]
    if not slots or not any(s["section"] == "SUMMARY" for s in slots):
        raise ValueError("Source resume layout is unsupported: no summary/bullet template found")
    for s in slots:
        s["maxLines"] = len(s["baselines"])
    return {"pages": len(doc), "cv": "\n".join(p.get_text() for p in doc), "slots": slots}


def fonts(doc):
    found = {}
    for page in doc:
        for f in page.get_fonts():
            name = f[3].lower()
            if "timesnewroman" in name:
                key = "bold" if "bold" in name else "normal" if "italic" not in name else "italic"
                found[key] = doc.extract_font(f[0])[3]
    result = {}
    for key, filename in [("normal", "times.ttf"), ("bold", "timesbd.ttf")]:
        system = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / filename
        data = system.read_bytes() if system.exists() else found.get(key)
        if not data:
            raise ValueError(f"Source Times New Roman {key} font is unavailable")
        result[key] = (data, fitz.Font(fontbuffer=data))
    return result


def styled_tokens(text, keywords):
    # Styling is explicit data; Markdown/HTML never reaches the PDF.
    if "**" in text or re.search(r"</?\w+[^>]*>", text):
        raise ValueError("Use plain resume text with boldKeywords, not Markdown/HTML")
    ranges = []
    for keyword in keywords:
        if not keyword.strip():
            raise ValueError("Empty bold keyword")
        matches = list(re.finditer(r"(?<!\w)" + re.escape(keyword) + r"(?!\w)", text, re.I))
        if not matches:
            raise ValueError(f"Bold keyword is absent from paragraph: {keyword}")
        ranges.extend((m.start(), m.end()) for m in matches)
    tokens = []
    for m in re.finditer(r"\S+|\s+", text):
        # Split tokens at style boundaries, including punctuation adjacent to keywords.
        points = sorted({m.start(), m.end()} | {p for r in ranges for p in r if m.start() < p < m.end()})
        for a, b in zip(points, points[1:]):
            tokens.append((text[a:b], any(start <= a < end for start, end in ranges)))
    return tokens


def wrap(slot, edit, fontset):
    lines = [[]]
    width = 0
    for text, bold in styled_tokens(edit["text"], edit["boldKeywords"]):
        key = "bold" if bold else "normal"
        font = fontset[key][1]
        if any(not font.has_glyph(ord(c)) for c in text if not c.isspace()):
            raise ValueError(f"Unsupported character in {slot['id']}")
        measure = font.text_length(text, fontsize=slot["size"])
        if text.isspace() and not lines[-1]:
            continue
        if width + measure > slot["right"] - slot["x"] + 0.1:
            if text.isspace():
                continue
            while lines[-1] and lines[-1][-1][0].isspace():
                lines[-1].pop()
            lines.append([])
            width = 0
        if measure > slot["right"] - slot["x"]:
            raise ValueError(f"Unbreakable text is too wide in {slot['id']}")
        lines[-1].append((text, key, measure))
        width += measure
    if len(lines) > slot["maxLines"]:
        raise ValueError(f"{slot['id']} exceeds its original {slot['maxLines']}-line space ({len(lines)} lines). Shorten this paragraph; do not shrink the font or move sections.")
    return lines


def plan(doc, payload):
    layout = template(doc)
    edits = {e["id"]: e for e in payload["edits"]}
    if len(edits) != len(payload["edits"]) or set(edits) != {s["id"] for s in layout["slots"]}:
        raise ValueError("Resume edits must cover each original paragraph exactly once")
    fontset = fonts(doc)
    prepared = [(s, wrap(s, edits[s["id"]], fontset)) for s in layout["slots"]]
    return layout, edits, fontset, prepared


def set_text_maps(doc, fontset, edits):
    # Windows Times maps some shared glyphs to NBSP, soft hyphen and Greek
    # question mark. Prefer ASCII in the PDF's extraction map for ATS readers.
    characters = set("".join(e["text"] for e in edits.values())) | {chr(i) for i in range(32, 127)}
    patched = set()
    for page in doc:
        for resource in page.get_fonts():
            if not resource[4].startswith("resume_") or resource[0] in patched:
                continue
            patched.add(resource[0])
            key = resource[4].removeprefix("resume_")
            font = fontset[key][1]
            mapping = {}
            for char in sorted(characters, reverse=True):
                glyph = font.has_glyph(ord(char))
                if glyph:
                    mapping[glyph] = char.encode("utf-16-be").hex()
            entries = [f"<{glyph:04x}> <{unicode}>" for glyph, unicode in sorted(mapping.items())]
            chunks = [entries[i:i + 100] for i in range(0, len(entries), 100)]
            cmap = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <</Registry(Adobe)/Ordering(UCS)/Supplement 0>> def\n/CMapName /Resume-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
            for chunk in chunks:
                cmap += f"{len(chunk)} beginbfchar\n" + "\n".join(chunk) + "\nendbfchar\n"
            cmap += "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"
            xref = doc.get_new_xref()
            doc.update_object(xref, "<<>>")
            doc.update_stream(xref, cmap.encode("ascii"))
            doc.xref_set_key(resource[0], "ToUnicode", f"{xref} 0 R")


def render(source, payload, output):
    with fitz.open(source) as doc:
        layout, edits, fontset, prepared = plan(doc, payload)
        links = [[dict(l) for l in p.get_links()] for p in doc]
        for slot, _ in prepared:
            page = doc[slot["page"]]
            # Keep rules, vector bullets, title, employers, dates and all other objects.
            for rect in slot["rects"]:
                r = fitz.Rect(rect)
                page.add_redact_annot(r + (-0.1, -0.1, 0.1, 0.1), fill=(1, 1, 1), cross_out=False)
        for pi, page in enumerate(doc):
            page.apply_redactions(images=0, graphics=0)
            for key, (data, _) in fontset.items():
                page.insert_font(fontname=f"resume_{key}", fontbuffer=data)
            for slot, lines in prepared:
                if slot["page"] != pi:
                    continue
                for baseline, runs in zip(slot["baselines"], lines):
                    x = slot["x"]
                    for text, key, width in runs:
                        page.insert_text((x, baseline), text, fontname=f"resume_{key}", fontsize=slot["size"], color=(0.149, 0.149, 0.149))
                        x += width
            existing = {l.get("uri") for l in page.get_links()}
            for link in links[pi]:
                if link.get("uri") and link["uri"] not in existing:
                    page.insert_link({"kind": fitz.LINK_URI, "from": link["from"], "uri": link["uri"]})
        set_text_maps(doc, fontset, edits)
        doc.subset_fonts()
        doc.set_metadata({"title": "Tailored Resume", "author": "", "subject": ""})
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        # Save to a temporary sibling, validate, then atomically publish the PDF.
        temporary = str(output) + ".tmp.pdf"
        try:
            doc.save(temporary, garbage=4, deflate=True)
            with fitz.open(temporary) as check:
                if len(check) != layout["pages"]:
                    raise ValueError("Resume page count changed")
                for pi, page in enumerate(check):
                    if {l.get("uri") for l in links[pi]} - {l.get("uri") for l in page.get_links()}:
                        raise ValueError("A source hyperlink was lost")
                text = "\n".join(p.get_text(sort=True) for p in check)
                if re.search(r"\bdraft\b", text, re.I):
                    raise ValueError("Draft label is not allowed in the resume")
            os.replace(temporary, output)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return {"pages": layout["pages"], "text": text}


def main():
    command, source = sys.argv[1:3]
    if command == "template":
        with fitz.open(source) as doc:
            result = template(doc)
    else:
        payload = json.loads(sys.stdin.read())
        if command == "check":
            with fitz.open(source) as doc:
                plan(doc, payload)
            result = {"ok": True}
        elif command == "render":
            result = render(source, payload, sys.argv[3])
        else:
            raise ValueError("Unknown command")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
