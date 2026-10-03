"""Tests de la detección de PDF con contraseña en lossless_images.py y
redact.py, con PDFs sintéticos (PyMuPDF real): python -m unittest pdf_check_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

import pymupdf

import lossless_images
import pdf_check

HERE = os.path.dirname(os.path.abspath(__file__))


def make_pdf(path, pages=2, user_pw=None, owner_pw=None, blank=()):
    """PDF con texto («manzana1») en cada página salvo en las de `blank`, cifrado AES-256 si
    se da alguna contraseña (solo owner_pw = solo contraseña de propietario)."""
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=300, height=200)
        if i not in blank:
            page.insert_text((20, 100), f"manzana1 página {i + 1}", fontsize=14)
    kwargs = {}
    if user_pw is not None or owner_pw is not None:
        kwargs = {
            "encryption": pymupdf.PDF_ENCRYPT_AES_256,
            "user_pw": user_pw or "",
            "owner_pw": owner_pw or "",
            "permissions": int(pymupdf.PDF_PERM_PRINT),
        }
    doc.save(path, **kwargs)
    return path


class PdfCheckTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        d = self.dir.name
        self.plain = make_pdf(os.path.join(d, "plain.pdf"))
        self.open_pw = make_pdf(os.path.join(d, "a.pdf"), user_pw="qa1234", owner_pw="qa1234-owner")
        self.owner_only = make_pdf(os.path.join(d, "b.pdf"), owner_pw="qa1234-owner")

    def path(self, name):
        return os.path.join(self.dir.name, name)

    def test_needs_password_solo_con_contrasena_de_apertura(self):
        self.assertTrue(pdf_check.needs_password(pymupdf.open(self.open_pw)))
        self.assertFalse(pdf_check.needs_password(pymupdf.open(self.owner_only)))
        self.assertFalse(pdf_check.needs_password(pymupdf.open(self.plain)))

    def test_lossless_images_no_procesa_un_pdf_con_contrasena(self):
        out = self.path("protegido.pdf")
        self.assertEqual(
            lossless_images.main(["", "protect", self.open_pw, out]), pdf_check.EXIT_ENCRYPTED
        )
        self.assertFalse(os.path.exists(out))
        # Solo propietario: sigue como cualquier otro (sin imágenes que proteger, 0).
        self.assertEqual(lossless_images.main(["", "protect", self.owner_only, out]), 0)

    def test_redact_no_procesa_un_pdf_con_contrasena(self):
        patterns = self.path("patrones.json")
        with open(patterns, "w", encoding="utf-8") as f:
            json.dump({"custom_0": "manzana1"}, f)
        for pdf, code in ((self.open_pw, pdf_check.EXIT_ENCRYPTED), (self.owner_only, 0)):
            results = self.path("resultados.json")
            r = subprocess.run(
                [sys.executable, os.path.join(HERE, "redact.py"), "search", pdf, patterns, results],
                cwd=HERE,
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, code, r.stderr)
            if code == 0:
                with open(results, encoding="utf-8") as f:
                    self.assertTrue(json.load(f)["results"])


if __name__ == "__main__":
    unittest.main()
