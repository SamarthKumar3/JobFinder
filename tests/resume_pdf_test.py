import importlib.util
from pathlib import Path
import tempfile
import unittest

import pymupdf as fitz

spec = importlib.util.spec_from_file_location("resume_pdf", Path(__file__).parents[1] / "scripts/resume_pdf.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class ResumeLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "original.pdf"
        self.output = Path(self.temp.name) / "tailored.pdf"
        doc = fitz.open()
        p = doc.new_page(width=595.92, height=842.88)
        for name, file in [("normal", "times.ttf"), ("bold", "timesbd.ttf")]:
            p.insert_font(fontname=name, fontfile=str(Path("C:/Windows/Fonts") / file))
        p.insert_text((160, 64), "CANDIDATE NAME", fontname="bold", fontsize=17.887)
        p.insert_text((160, 82), "Email | LinkedIn | GitHub", fontname="normal", fontsize=10.434)
        for i, uri in enumerate(["mailto:example@example.com", "https://linkedin.com/in/example", "https://github.com/example"]):
            p.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(160 + i * 40, 72, 200 + i * 40, 84), "uri": uri})
        p.insert_text((44.72, 98), "SUMMARY", fontname="bold", fontsize=10.434)
        p.draw_line((44.72, 104), (551.53, 104))
        p.insert_text((44.72, 116), "Python engineer building FastAPI services and reliable applications.", fontname="normal", fontsize=10.434)
        p.insert_text((44.72, 180), "WORK EXPERIENCE", fontname="bold", fontsize=10.434)
        p.insert_text((44.72, 200), "Example Employer", fontname="bold", fontsize=10.434)
        p.draw_circle((45.46, 218), 1.49, fill=(0, 0, 0), color=None)
        p.insert_text((55.15, 221), "Built Python services with FastAPI; production-grade APIs.", fontname="normal", fontsize=10.434)
        doc.new_page(width=595.92, height=842.88)
        doc.save(self.source)
        doc.close()
        with fitz.open(self.source) as source:
            self.template = renderer.template(source)
        self.payload = {"edits": [{"id": s["id"], "text": s["text"], "boldKeywords": ["Python", "FastAPI"]} for s in self.template["slots"]]}

    def test_preserves_original_pages_header_rules_bullets_and_clickable_links(self):
        renderer.render(self.source, self.payload, self.output)
        with fitz.open(self.source) as original, fitz.open(self.output) as output:
            self.assertEqual(len(original), len(output))
            self.assertEqual(original[0].rect, output[0].rect)
            self.assertEqual([l["uri"] for l in original[0].get_links()], [l["uri"] for l in output[0].get_links()])
            # Header pixels, including links, must be identical to the original.
            self.assertEqual(original[0].get_pixmap(clip=fitz.Rect(0, 0, 595, 100)).samples, output[0].get_pixmap(clip=fitz.Rect(0, 0, 595, 100)).samples)
            before = [(tuple(d["rect"]), d["type"]) for d in original[0].get_drawings()]
            after = [(tuple(d["rect"]), d["type"]) for d in output[0].get_drawings()]
            for drawing in before:
                self.assertIn(drawing, after)
            spans = [s for b in output[0].get_text("dict")["blocks"] if b["type"] == 0 for l in b["lines"] for s in l["spans"]]
            self.assertTrue(any("FastAPI" in s["text"] and "Bold" in s["font"] for s in spans))
            self.assertNotIn("draft", output[0].get_text().lower())
            self.assertEqual(output[0].get_text().replace("\u00a0", " ").count("Built Python"), 1)
            self.assertIn("FastAPI; production-grade APIs.", output[0].get_text())
            self.assertTrue(all(abs(s["size"] - 10.434) < 0.01 for s in spans if s["origin"][1] > 100))

    def test_rejects_overflow_without_creating_a_pdf_or_shrinking_fonts(self):
        self.payload["edits"][0]["text"] = "Python FastAPI " * 100
        with self.assertRaisesRegex(ValueError, "exceeds its original"):
            renderer.render(self.source, self.payload, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_missing_paragraphs_and_raw_markup(self):
        with fitz.open(self.source) as source:
            with self.assertRaisesRegex(ValueError, "exactly once"):
                renderer.plan(source, {"edits": []})
            self.payload["edits"][0]["text"] = "**Python** FastAPI"
            with self.assertRaisesRegex(ValueError, "Markdown"):
                renderer.plan(source, self.payload)


if __name__ == "__main__":
    unittest.main()
