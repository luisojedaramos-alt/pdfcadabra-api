"""Tests de redact.py con PDFs sintéticos creados al vuelo (sin datos reales).

Uso: python -m unittest redact_test.py   (necesita PyMuPDF, como redact.py)
"""
import os
import struct
import tempfile
import unittest
import zlib

import pymupdf as fitz

import redact

TERM = "manzana1"


def tmp_path(test, name):
    d = tempfile.mkdtemp(prefix="redact-test-")
    test.addCleanup(lambda: [os.remove(os.path.join(d, f)) for f in os.listdir(d)] and None or os.rmdir(d))
    return os.path.join(d, name)


def search_items(path, word):
    """Hallazgos como los que envía el frontend, usando la búsqueda de redact.py."""
    doc = fitz.open(path)
    redact.flatten_document(doc)
    items = []
    for page in doc:
        for r in page.search_for(word):
            items.append({"id": f"{page.number}-{len(items)}", "page": page.number, "text": word,
                          "category": "Personalizado", "rect": [r.x0, r.y0, r.x1, r.y1]})
    doc.close()
    return items


def all_text(path):
    """Todo lo que podría delatar un término: texto, campos, metadatos, XMP, marcadores,
    adjuntos y los flujos descomprimidos."""
    doc = fitz.open(path)
    parts = [p.get_text() for p in doc]
    parts += [str(w.field_value) for p in doc for w in p.widgets()]
    parts += [str(v) for v in doc.metadata.values()]
    parts.append(doc.get_xml_metadata())
    parts += [e[1] for e in doc.get_toc()]
    parts += [doc.embfile_get(n).decode("latin-1") for n in doc.embfile_names()]
    for x in range(1, doc.xref_length()):
        parts.append(doc.xref_object(x))
        if doc.xref_is_stream(x):
            parts.append((doc.xref_stream(x) or b"").decode("latin-1"))
    doc.close()
    return "\n".join(parts)


def make_form_pdf(path):
    """Como formulario.pdf de scripts/qa/generar-muestras.mjs (archivo 6 de la QA): el
    término está en el texto de la página y en el valor de un campo de texto. Además,
    en un marcador, en los metadatos, en el XMP y en un adjunto."""
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((60, 60), f"Referencia {TERM} del juicio ordinario 123/2026", fontsize=12)
    page.insert_text((60, 270), "Expediente:", fontsize=12)
    page.insert_text((60, 700), "Resolución del índice, España, pingüino", fontsize=12)
    w = fitz.Widget()
    w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    w.field_name = "expediente"
    w.field_value = TERM
    w.rect = fitz.Rect(200, 255, 500, 280)
    page.add_widget(w)
    doc.set_toc([[1, f"Expediente {TERM}", 1], [2, "Hijo del marcador", 1], [1, "Anexos", 1]])
    doc.set_metadata({"title": f"Caso {TERM}", "author": "Autor ficticio"})
    doc.set_xml_metadata(f'<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc>{TERM}</dc></x:xmpmeta>')
    doc.embfile_add("nota.txt", f"nota con {TERM}".encode(), filename="nota.txt")
    doc.save(path)
    doc.close()


QUOTE_LINES = [
    "Documento de prueba con el operador comilla",
    "Demandante: Persona Ficticia Uno, con DNI 12345678Z.",
    "Correo de contacto: persona.ficticia@example.com",
    "Vistos por el magistrado los presentes autos",
]


def make_quote_pdf(path, content=None):
    """Texto escrito con el operador ' (como texto.pdf de scripts/test-migracion, el
    archivo 7 de la QA): "14 TL 60 780 Td (línea) ' (línea) ' ..."."""
    if content is None:
        ops = ["BT /F1 11 Tf 14 TL 60 780 Td"]
        ops += [f"({line}) '" for line in QUOTE_LINES]
        ops.append('2 0.5 (Linea con comilla doble) "')
        ops.append("ET")
        content = "\n".join(ops)
    data = zlib.compress(content.encode("latin-1"))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d /Filter /FlateDecode >>\nstream\n" % len(data) + data + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    with open(path, "wb") as f:
        f.write(out)


def words(path, page=0):
    doc = fitz.open(path)
    try:
        return [w[4] for w in doc[page].get_text("words")]
    finally:
        doc.close()


class RewriteQuoteOperators(unittest.TestCase):
    def test_comilla_simple_y_doble(self):
        self.assertEqual(redact.rewrite_quote_operators(b"BT 14 TL (a) ' ET"), b"BT 14 TL T* (a) Tj ET")
        self.assertEqual(
            redact.rewrite_quote_operators(b'BT 1 0.5 <41> " ET'),
            b"BT 1 Tw 0.5 Tc T* <41> Tj ET",
        )

    def test_sin_operadores_no_cambia(self):
        self.assertIsNone(redact.rewrite_quote_operators(b"BT (it's \\(a\\) \"x\") Tj ET"))
        self.assertIsNone(redact.rewrite_quote_operators(b"BT [(a ' b) -20 (c)] TJ ET % ' en comentario"))

    def test_imagen_en_linea_con_comillas_en_los_datos(self):
        data = b"q BI /W 2 /H 1 /BPC 8 /CS /G ID '\" EI Q BT (x) ' ET"
        self.assertEqual(
            redact.rewrite_quote_operators(data),
            b"q BI /W 2 /H 1 /BPC 8 /CS /G ID '\" EI Q BT T* (x) Tj ET",
        )

    def test_flujo_roto_se_detecta(self):
        with self.assertRaises(redact._ContentSyntaxError):
            redact.rewrite_quote_operators(b"BT (sin cerrar ' ET")


class Fallo1FormularioArchivo6(unittest.TestCase):
    """El valor de un campo con el término se conservaba y se veía tras censurar."""

    def test_campo_marcador_metadatos_y_adjunto_sin_el_termino(self):
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_form_pdf(src)
        items = search_items(src, TERM)
        self.assertEqual(len(items), 2)  # el de la página y el del campo (aplanado)
        report = redact.apply(src, out, items)
        self.assertTrue(report["verified"], report)
        self.assertEqual(report["text_loss_pages"], [])
        self.assertNotIn(TERM, all_text(out).casefold())
        doc = fitz.open(out)
        self.assertFalse(doc.is_form_pdf)
        self.assertEqual([e[1] for e in doc.get_toc()], ["Hijo del marcador", "Anexos"])
        self.assertEqual(doc.embfile_count(), 0)
        doc.close()
        # El resto del texto sigue ahí y se puede extraer.
        self.assertIn("pingüino", words(out))
        self.assertIn("Expediente:", words(out))

    def test_busqueda_encuentra_el_valor_del_campo(self):
        src, res, pat = tmp_path(self, "in.pdf"), tmp_path(self, "r.json"), tmp_path(self, "p.json")
        make_form_pdf(src)
        with open(pat, "w", encoding="utf-8") as f:
            f.write('{"Personalizado": "(?i)manzana1"}')
        redact.search(src, pat, res)
        import json
        with open(res, encoding="utf-8") as f:
            rects = [r["rect"] for r in json.load(f)["results"]]
        self.assertEqual(len(rects), 2)
        self.assertTrue(any(fitz.Rect(r).intersects(fitz.Rect(200, 255, 500, 280)) for r in rects))


class VerificacionFinal(unittest.TestCase):
    def test_si_queda_el_termino_no_se_entrega(self):
        """Sin aplanar (el fallo 1), el campo conserva el término: verified=False y no hay salida."""
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_form_pdf(src)
        items = search_items(src, TERM)
        real_flatten, real_scrub = redact.flatten_document, fitz.Document.scrub
        redact.flatten_document = lambda doc: []
        fitz.Document.scrub = lambda doc, **kw: real_scrub(doc, **{**kw, "reset_fields": False})
        try:
            report = redact.apply(src, out, items)
        finally:
            redact.flatten_document, fitz.Document.scrub = real_flatten, real_scrub
        self.assertFalse(report["verified"])
        self.assertIn("form_fields", report["leaks"])
        self.assertFalse(os.path.exists(out))
        self.assertNotIn(TERM, repr(report))  # el informe (que va al log) no lleva términos

    def test_detecta_cada_sitio(self):
        path = tmp_path(self, "f.pdf")
        make_form_pdf(path)
        doc = fitz.open(path)
        zones = {0: doc[0].search_for(TERM)}
        doc.close()
        leaks = redact.verify_redaction(path, zones, {TERM})
        self.assertEqual(
            leaks,
            # pdf_objects: el barrido de objetos también ve el término en esos mismos sitios.
            ["attachments", "form_fields", "metadata_info", "metadata_xmp", "outline", "page_text", "pdf_objects"],
        )

    def test_aparicion_no_seleccionada_no_es_fuga(self):
        """El usuario puede desmarcar una aparición: si queda fuera de las zonas, no es fuga."""
        path = tmp_path(self, "f.pdf")
        doc = fitz.open()
        doc.new_page().insert_text((60, 60), f"{TERM} y otra vez {TERM}")
        doc.save(path)
        doc.close()
        self.assertEqual(redact.verify_redaction(path, {0: [fitz.Rect(0, 0, 1, 1)]}, {TERM}), [])


class CapaOcr(unittest.TestCase):
    def test_bajo_la_zona_desaparece_y_el_resto_sigue_buscable(self):
        """Escaneo con capa OCR invisible (render mode 3): el término bajo la zona se borra
        también de la capa, y el resto de la capa se conserva y se puede buscar."""
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((60, 60), f"Expediente {TERM} del juicio ordinario 123/2026", fontsize=12, render_mode=3)
        page.insert_text((60, 90), "Resolución del índice, España, pingüino", fontsize=12, render_mode=3)
        doc.save(src)
        doc.close()
        items = search_items(src, TERM)
        self.assertEqual(len(items), 1)
        report = redact.apply(src, out, items)
        self.assertTrue(report["verified"], report)
        self.assertEqual(report["text_loss_pages"], [])
        self.assertNotIn(TERM, all_text(out).casefold())
        doc = fitz.open(out)
        for word in ("Expediente", "123/2026", "pingüino"):
            self.assertTrue(doc[0].search_for(word), f"{word} debe seguir en la capa OCR")
        doc.close()


class Fallo2OperadorComillaArchivo7(unittest.TestCase):
    """Con texto escrito con ', censurar un DNI borraba todo el texto de la página."""

    def _apply_dni(self, src, out):
        items = search_items(src, "12345678Z")
        self.assertEqual(len(items), 1)
        return redact.apply(src, out, items)

    def test_solo_desaparece_el_dni(self):
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_quote_pdf(src)
        before = words(src)
        report = self._apply_dni(src, out)
        self.assertTrue(report["verified"], report)
        self.assertEqual(report["text_loss_pages"], [])
        after = words(out)
        self.assertNotIn("12345678Z.", after)
        # El punto que sigue al DNI queda fuera de la zona y se conserva.
        self.assertEqual([w if w != "12345678Z." else "." for w in before], after)
        # Y en su sitio: la primera y la última línea no se han movido.
        doc_in, doc_out = fitz.open(src), fitz.open(out)
        for word in ("Documento", "comilla", "doble"):
            self.assertEqual(doc_in[0].search_for(word), doc_out[0].search_for(word))

    def test_sin_reescritura_no_se_entrega(self):
        """Sin la reescritura de ' (el fallo 2), MuPDF saca el texto de la página sin borrar
        el DNI (sigue en el flujo, fuera de la página): la verificación no lo entrega.
        Antes se entregaba con X-Redact-Text-Loss (auditoría 2026-10-07, hallazgo 1)."""
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_quote_pdf(src)
        real = redact.normalize_quote_operators
        redact.normalize_quote_operators = lambda doc: (0, 0)
        try:
            report = self._apply_dni(src, out)
        finally:
            redact.normalize_quote_operators = real
        self.assertFalse(report["verified"])
        self.assertIn("hidden_text", report["leaks"])
        self.assertFalse(os.path.exists(out))


def make_xref_gap_pdf(path):
    """xref en flujo con /Index por tramos ([0 5 8 2]: faltan los objetos 5 a 7), como la
    que escribe pdf-lib (p. ej. la salida de Unir). Es válido, pero doc.scrub() aborta."""
    content = f"BT /F1 11 Tf 60 780 Td (Expediente {TERM} de prueba) Tj ET".encode()
    objs = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>",
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        8: b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    }
    out = bytearray(b"%PDF-1.5\n")
    off = {}
    for n, body in objs.items():
        off[n] = len(out)
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    off[9] = len(out)
    rows = b"".join(
        struct.pack(">BIH", 0 if n == 0 else 1, off.get(n, 0), 65535 if n == 0 else 0)
        for n in (0, 1, 2, 3, 4, 8, 9)
    )
    out += b"9 0 obj\n<< /Type /XRef /Size 10 /Root 1 0 R /W [1 4 2] /Index [0 5 8 2] /Length %d >>\n" % len(rows)
    out += b"stream\n" + rows + b"\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n" % off[9]
    with open(path, "wb") as f:
        f.write(out)


class XrefConHuecos(unittest.TestCase):
    """doc.scrub() abortaba con "cannot find object in xref" en PDFs salidos de Unir."""

    def test_se_censura_igual(self):
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_xref_gap_pdf(src)
        with self.assertRaises(RuntimeError):  # el fallo de PyMuPDF que se esquiva
            fitz.open(src).scrub()
        report = redact.apply(src, out, search_items(src, TERM))
        self.assertTrue(report["verified"], report)
        self.assertEqual(words(out), ["Expediente", "de", "prueba"])


def make_scan_pdf(path, kind):
    """Escaneo sintético de 2 páginas sin texto: JPEG en gris con ruido ("jpeg") o 1 bit
    ("1bit", Flate) a pantalla completa."""
    import random
    rng = random.Random(7)
    w, h = 1240, 1754
    doc = fitz.open()
    for _ in range(2):
        page = doc.new_page(width=595, height=842)
        if kind == "jpeg":
            samples = bytes(200 + rng.randrange(40) for _ in range(w * h))
            pix = fitz.Pixmap(fitz.csGRAY, w, h, samples, 0)
            page.insert_image(page.rect, stream=pix.tobytes("jpg", jpg_quality=60))
        else:
            stride = (w + 7) // 8
            rows = bytes(0xFF if (x // 40 + y // 40) % 2 else 0xF0 for y in range(h) for x in range(stride))
            xref = doc.get_new_xref()
            doc.update_object(xref, f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
                                    "/ColorSpace /DeviceGray /BitsPerComponent 1 >>")
            doc.update_stream(xref, rows)
            page.insert_text((0, 0), " ")  # crea /Contents y /Resources
            doc.xref_set_key(page.xref, "Resources", f"<< /XObject << /Scan {xref} 0 R >> >>")
            doc.update_stream(page.get_contents()[0], b"q 595 0 0 842 0 0 cm /Scan Do Q")
    doc.save(path)
    doc.close()


ZONE = [120, 140, 300, 165]


def zone_items(n_pages):
    return [{"id": str(i), "page": i, "text": "Zona manual", "category": "Censura Manual", "rect": ZONE}
            for i in range(n_pages)]


def image_info(path):
    doc = fitz.open(path)
    try:
        return [(doc.xref_get_key(im[0], "Filter")[1], im[4]) for im in doc[0].get_images(full=True)]
    finally:
        doc.close()


def zone_is_black(path):
    doc = fitz.open(path)
    try:
        pix = doc[0].get_pixmap(dpi=72, clip=fitz.Rect(ZONE) + (4, 4, -4, -4), colorspace=fitz.csGRAY)
        return max(pix.samples) < 30
    finally:
        doc.close()


class TamanoDeSalida(unittest.TestCase):
    """apply_redactions dejaba las imágenes tocadas sin comprimir: un escaneo JPEG se
    multiplicaba por 3-5 y uno en CCITT pasaba a Flate."""

    def test_escaneo_jpeg_sigue_en_jpeg_y_no_crece(self):
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_scan_pdf(src, "jpeg")
        report = redact.apply(src, out, zone_items(2))
        self.assertTrue(report["verified"])
        self.assertLessEqual(os.path.getsize(out), os.path.getsize(src) * 1.1)
        self.assertIn("DCTDecode", image_info(out)[0][0])
        self.assertTrue(zone_is_black(out))

    def test_escaneo_1bit_vuelve_a_ccitt_sin_perdida(self):
        src, out = tmp_path(self, "in.pdf"), tmp_path(self, "out.pdf")
        make_scan_pdf(src, "1bit")
        report = redact.apply(src, out, zone_items(2))
        self.assertTrue(report["verified"])
        self.assertEqual(image_info(out)[0], ("/CCITTFaxDecode", 1))
        self.assertTrue(zone_is_black(out))
        # Fuera de la zona, los píxeles son los mismos (G4 no tiene pérdida).
        a = fitz.open(src)[0].get_pixmap(dpi=72, clip=fitz.Rect(300, 400, 500, 600))
        b = fitz.open(out)[0].get_pixmap(dpi=72, clip=fitz.Rect(300, 400, 500, 600))
        self.assertEqual(a.samples, b.samples)

    def test_calidad_jpeg_estimada(self):
        pix = fitz.Pixmap(fitz.csGRAY, 64, 64, bytes(range(256)) * 16, 0)
        for q in (40, 60, 85):
            self.assertAlmostEqual(redact.jpeg_quality(pix.tobytes("jpg", jpg_quality=q)), q, delta=2)
        self.assertIsNone(redact.jpeg_quality(b"no es un jpeg"))


if __name__ == "__main__":
    unittest.main()
