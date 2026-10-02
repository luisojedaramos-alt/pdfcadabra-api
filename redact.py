import json
import os
import re
import sys
import unicodedata
import uuid
from collections import Counter

import pymupdf as fitz

fitz.TOOLS.mupdf_display_errors(False)

# Metadatos que escribimos en la salida: la verificación final no los cuenta como fuga
# aunque un término censurado coincida con ellos.
OUTPUT_METADATA = {"creator": "PDFcadabra", "producer": "PDFcadabra LegalTech"}

# Términos más cortos no se buscan fuera del texto de página (metadatos, marcadores...):
# darían falsos positivos ("de", "y"). El texto de página se comprueba por geometría.
MIN_TERM_LEN = 3

MANUAL_CATEGORY = "Censura Manual"


# ==========================================
# 1. OPERADORES ' Y " (fallo de MuPDF 1.28.2)
# ==========================================
# El filtro de contenido de MuPDF (apply_redactions, clean_contents y scrub) reescribe
# "14 TL 60 780 Td (texto) '" como "60 780 TD T* (texto)Tj": pierde el TL y el TD fija el
# interlineado a -780, así que cada línea salta 780 pt y todo el texto de la página queda
# fuera de ella. Con T* + Tj explícitos no pasa. Antes de censurar reescribimos
#   (s) '         ->  T* (s) Tj
#   aw ac (s) "   ->  aw Tw ac Tc T* (s) Tj
# que es la definición de ambos operadores en la norma (ISO 32000-1, 9.4.3).

_WS = b"\x00\t\n\x0c\r "
_DELIM = b"()<>[]{}/%"
_LITERALS = {b"true", b"false", b"null"}
_NUMBER = re.compile(rb"^[+-]?(\d+\.?\d*|\.\d+)$")


class _ContentSyntaxError(Exception):
    pass


def _skip_string(data, i):
    """i apunta a '('; devuelve el índice tras el ')' que lo cierra."""
    depth = 0
    n = len(data)
    while i < n:
        c = data[i]
        if c == 0x5C:  # barra invertida: el siguiente byte no cuenta
            i += 2
            continue
        if c == 0x28:
            depth += 1
        elif c == 0x29:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise _ContentSyntaxError("cadena sin cerrar")


def _skip_inline_image(data, i):
    """i apunta justo tras el operador ID; devuelve el índice tras el EI final."""
    n = len(data)
    j = i + 1  # un byte de espacio tras ID
    while True:
        k = data.find(b"EI", j)
        if k == -1:
            raise _ContentSyntaxError("imagen en línea sin EI")
        before_ok = k > 0 and data[k - 1] in _WS
        after_ok = k + 2 >= n or data[k + 2] in _WS or data[k + 2] in _DELIM
        if before_ok and after_ok:
            return k + 2
        j = k + 2


def rewrite_quote_operators(data):
    """Devuelve el flujo de contenido con ' y " reescritos, o None si no hay ninguno.

    Lanza _ContentSyntaxError si el flujo no se puede analizar (se deja como está).
    """
    if b"'" not in data and b'"' not in data:
        return None
    out = bytearray()
    copied = 0  # bytes de data ya copiados a out
    operands = []  # (inicio, fin) de los operandos desde el último operador
    group_start = None  # inicio del array o diccionario de primer nivel en curso
    depth = 0
    changed = False
    i = 0
    n = len(data)

    def add_operand(start, end):
        if depth == 0:
            operands.append((start, end))

    while i < n:
        c = data[i]
        if c in _WS:
            i += 1
            continue
        if c == 0x25:  # comentario
            while i < n and data[i] not in b"\r\n":
                i += 1
            continue
        start = i
        if c == 0x28:
            i = _skip_string(data, i)
            add_operand(start, i)
            continue
        if data.startswith(b"<<", i) or c == 0x5B:  # inicio de diccionario o array
            if depth == 0:
                group_start = start
            depth += 1
            i += 2 if c == 0x3C else 1
            continue
        if data.startswith(b">>", i) or c == 0x5D:
            depth -= 1
            i += 2 if c == 0x3E else 1
            if depth < 0:
                raise _ContentSyntaxError("cierre sin apertura")
            if depth == 0:
                operands.append((group_start, i))
            continue
        if c == 0x3C:  # cadena hexadecimal
            k = data.find(b">", i)
            if k == -1:
                raise _ContentSyntaxError("cadena hexadecimal sin cerrar")
            i = k + 1
            add_operand(start, i)
            continue
        if c in b")>]{}":
            raise _ContentSyntaxError("delimitador inesperado")
        # Nombre, número, true/false/null u operador.
        i += 1
        while i < n and data[i] not in _WS and data[i] not in _DELIM:
            i += 1
        token = data[start:i]
        if c == 0x2F or token in _LITERALS or _NUMBER.match(token) or depth > 0:
            add_operand(start, i)
            continue
        # Es un operador.
        if token == b"'" and len(operands) >= 1:
            s0, s1 = operands[-1]
            out += data[copied:s0] + b"T* " + data[s0:s1] + b" Tj"
            copied = i
            changed = True
        elif token == b'"' and len(operands) >= 3:
            (a0, a1), (b0, b1), (s0, s1) = operands[-3:]
            out += (
                data[copied:a0]
                + data[a0:a1]
                + b" Tw "
                + data[b0:b1]
                + b" Tc T* "
                + data[s0:s1]
                + b" Tj"
            )
            copied = i
            changed = True
        elif token == b"ID":
            i = _skip_inline_image(data, i)
        operands = []
    if depth != 0:
        raise _ContentSyntaxError("array o diccionario sin cerrar")
    if not changed:
        return None
    out += data[copied:]
    return bytes(out)


def normalize_quote_operators(doc):
    """Reescribe ' y " en los contenidos de página y en los Form XObjects.

    Devuelve cuántos flujos se reescribieron y cuántos no se pudieron analizar.
    """
    xrefs = set()
    for page in doc:
        xrefs.update(page.get_contents())
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_is_stream(xref) and doc.xref_get_key(xref, "Subtype") == ("name", "/Form"):
                xrefs.add(xref)
        except Exception:
            continue
    rewritten = skipped = 0
    for xref in sorted(xrefs):
        try:
            data = doc.xref_stream(xref)
            new = rewrite_quote_operators(data) if data else None
        except _ContentSyntaxError:
            skipped += 1  # se deja tal cual: la comprobación de texto conservado avisará
            continue
        if new is not None:
            doc.update_stream(xref, new)
            rewritten += 1
    return rewritten, skipped


# ==========================================
# 2. APLANADO DE FORMULARIOS Y ANOTACIONES
# ==========================================
def flatten_document(doc):
    """Convierte campos de formulario y anotaciones en contenido de página.

    Así la censura alcanza los valores de los campos (que no son texto de página) y el
    PDF deja de tener campos con el dato. Las anotaciones de censura que ya traiga el
    documento (marcadas en Acrobat sin aplicar) no se aplanan: se devuelven para
    aplicarlas junto con las nuestras, como hacía doc.scrub(redactions=True).
    """
    pending = []
    for page in doc:
        for annot in list(page.annots(types=[fitz.PDF_ANNOT_REDACT])):
            pending.append((page.number, fitz.Rect(annot.rect)))
            page.delete_annot(annot)
    doc.bake(annots=True, widgets=True)
    # Sin campos ya no hay formulario: fuera el /AcroForm (y con él un posible XFA, cuyos
    # datos son XML con los valores de los campos).
    cat = doc.pdf_catalog()
    if doc.xref_get_key(cat, "AcroForm")[0] != "null":
        doc.xref_set_key(cat, "AcroForm", "null")
    return pending


# ==========================================
# 3. TEXTO Y TÉRMINOS
# ==========================================
def norm(s):
    """Forma comparable de un texto: NFC, minúsculas y espacios simples."""
    s = unicodedata.normalize("NFC", s or "").casefold()
    return re.sub(r"\s+", " ", s).strip()


def _is_hidden_span(span):
    """Mismo criterio que doc.scrub(hidden_text=True) en PyMuPDF 1.28.2."""
    font = span.get("font")
    if isinstance(font, str) and font.split("+")[-1] == "GlyphLessFont":
        return True
    if span.get("alpha") == 0:
        return True
    flags = span.get("char_flags")
    filled = getattr(fitz.mupdf, "FZ_STEXT_FILLED", None)
    stroked = getattr(fitz.mupdf, "FZ_STEXT_STROKED", None)
    if isinstance(flags, int) and isinstance(filled, int) and isinstance(stroked, int):
        if not (flags & filled) and not (flags & stroked):
            return True
    return False


def page_words(page):
    """Palabras de la página como [(texto, Rect, oculta)], a partir de los caracteres."""
    words = []
    raw = page.get_text("rawdict", flags=fitz.TEXT_PRESERVE_SPANS | fitz.TEXT_COLLECT_STYLES)
    for block in raw.get("blocks", ()):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", ()):
            for span in line.get("spans", ()):
                hidden = _is_hidden_span(span)
                text, box = [], fitz.Rect()
                for ch in span.get("chars", ()) + [{"c": " ", "bbox": None}]:
                    if ch["c"].isspace():
                        if text:
                            words.append(("".join(text), box, hidden))
                        text, box = [], fitz.Rect()
                        continue
                    text.append(ch["c"])
                    box |= fitz.Rect(ch["bbox"])
    return words


def page_chars(page):
    """Caracteres de la página como [(carácter, Rect)]."""
    chars = []
    raw = page.get_text("rawdict")
    for block in raw.get("blocks", ()):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", ()):
            for span in line.get("spans", ()):
                for ch in span.get("chars", ()):
                    if not ch["c"].isspace():
                        chars.append((ch["c"], fitz.Rect(ch["bbox"])))
    return chars


def _center_in(rect, zones):
    x = (rect.x0 + rect.x1) / 2
    y = (rect.y0 + rect.y1) / 2
    return any(z.x0 <= x <= z.x1 and z.y0 <= y <= z.y1 for z in zones)


def text_under_zones(page, zones):
    """Texto que hay bajo cada zona (caracteres con el centro dentro), una cadena por zona."""
    chars = page_chars(page)
    out = []
    for z in zones:
        s = "".join(c for c, r in chars if _center_in(r, [z]))
        if s:
            out.append(s)
    return out


def visible_words_outside(page, zones, margin=1.0):
    """Palabras visibles que no tocan ninguna zona: deben sobrevivir a la censura."""
    grown = [fitz.Rect(z.x0 - margin, z.y0 - margin, z.x1 + margin, z.y1 + margin) for z in zones]
    return Counter(
        w for w, r, hidden in page_words(page) if not hidden and not any(r.intersects(g) for g in grown)
    )


# ==========================================
# 4. MARCADORES
# ==========================================
def remove_outline_terms(doc, terms):
    """Quita los marcadores cuyo título contiene un término; sus hijos suben de nivel."""
    toc = doc.get_toc(simple=False)
    if not toc or not terms:
        return 0
    kept, removed = [], 0
    stack = []  # (nivel original, nivel nuevo) de los antepasados conservados
    for level, title, page, *rest in toc:
        while stack and stack[-1][0] >= level:
            stack.pop()
        if any(t in norm(title) for t in terms):
            removed += 1
            continue
        new_level = stack[-1][1] + 1 if stack else 1
        stack.append((level, new_level))
        kept.append([new_level, title, page, *rest])
    if removed:
        doc.set_toc(kept)
    return removed


# ==========================================
# 5. VERIFICACIÓN FINAL
# ==========================================
def _contains_term(value, terms):
    v = norm(value if isinstance(value, str) else str(value or ""))
    return bool(v) and any(t in v for t in terms)


def _decode_any(data):
    texts = []
    for enc in ("utf-8", "utf-16", "latin-1"):
        try:
            texts.append(data.decode(enc))
        except Exception:
            pass
    return texts


def verify_redaction(path, zones_by_page, terms):
    """Busca de nuevo en el PDF de salida. Devuelve la lista de sitios con fugas.

    - Texto de página: ningún carácter puede tener el centro dentro de una zona censurada
      (geometría: una aparición que el usuario decidió no censurar no es una fuga).
    - Campos, anotaciones, enlaces, metadatos (Info y XMP), marcadores y adjuntos: no
      puede aparecer ningún término censurado.
    Nunca devuelve los términos: el resultado va al log.
    """
    leaks = set()
    doc = fitz.open(path)
    try:
        for page in doc:
            zones = zones_by_page.get(page.number)
            if zones and any(_center_in(r, zones) for _, r in page_chars(page)):
                leaks.add("page_text")
            for w in page.widgets():
                if any(_contains_term(v, terms) for v in (w.field_value, w.field_label, w.field_name)):
                    leaks.add("form_fields")
            for a in page.annots():
                info = a.info or {}
                if any(_contains_term(v, terms) for v in info.values()):
                    leaks.add("annotations")
            for link in page.get_links():
                if any(_contains_term(link.get(k), terms) for k in ("uri", "file", "nameddest")):
                    leaks.add("links")

        if doc.xref_get_key(doc.pdf_catalog(), "AcroForm")[0] != "null":
            leaks.add("form_fields")

        for key, value in (doc.metadata or {}).items():
            if OUTPUT_METADATA.get(key) == value:
                continue
            if key not in ("format", "encryption") and _contains_term(value, terms):
                leaks.add("metadata_info")
        if _contains_term(doc.get_xml_metadata(), terms):
            leaks.add("metadata_xmp")

        if any(_contains_term(entry[1], terms) for entry in doc.get_toc(simple=False)):
            leaks.add("outline")

        for name in doc.embfile_names():
            info = doc.embfile_info(name)
            texts = [name, info.get("filename"), info.get("ufilename"), info.get("desc")]
            texts += _decode_any(doc.embfile_get(name))
            if any(_contains_term(t, terms) for t in texts):
                leaks.add("attachments")
    finally:
        doc.close()
    return sorted(leaks)


def text_loss_pages(path, zones_by_page, words_before):
    """Páginas (desde 1) que han perdido texto visible fuera de las zonas censuradas."""
    doc = fitz.open(path)
    try:
        return [
            page.number + 1
            for page in doc
            if words_before.get(page.number, Counter())
            - visible_words_outside(page, zones_by_page.get(page.number, []))
        ]
    finally:
        doc.close()


# ==========================================
# ACCIONES
# ==========================================
def search(input_path, patterns_path, results_path):
    with open(patterns_path, "r", encoding="utf-8") as f:
        patterns = json.load(f)

    doc = fitz.open(input_path)
    # Se busca sobre el documento aplanado, igual que el que censura apply: así también
    # aparecen los valores de los campos de formulario y el texto de las anotaciones.
    # Sus posiciones coinciden con las del original (el aplanado dibuja la apariencia del
    # campo en su mismo rectángulo).
    try:
        flatten_document(doc)
    except Exception as e:
        print(f"Aviso en redact.py: no se pudo aplanar para buscar: {e}", file=sys.stderr)
    results = []
    errors = []

    # Precompilamos los patrones una sola vez: un regex inválido se
    # reporta como error de categoría en vez de tumbar la búsqueda o
    # descartarse en silencio en cada página.
    compiled_patterns = {}
    for category, pattern in patterns.items():
        try:
            compiled_patterns[category] = re.compile(pattern)
        except re.error:
            errors.append({
                "category": category,
                "message": f"El patrón de búsqueda para '{category}' no es válido: revisa paréntesis o caracteres especiales."
            })

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")

        p_width = page.rect.width
        p_height = page.rect.height

        raw_rects = []

        for category, compiled_pattern in compiled_patterns.items():
            try:
                # Encontrar matches y obtener las posiciones reales en el texto
                for match in compiled_pattern.finditer(text):
                    val = match.group().strip()
                    if not val:
                        continue

                    # Avanzamos la búsqueda de contexto usando text.find con offset
                    # Esto garantiza un contexto real si el dato aparece múltiples veces.
                    start_search = 0

                    areas = page.search_for(val)
                    for area in areas:
                        # Buscar el índice del texto a partir de start_search
                        idx = text.find(val, start_search)
                        context = ""

                        if idx != -1:
                            start = max(0, idx - 30)
                            end = min(len(text), idx + len(val) + 30)
                            context = text[start:end].replace('\n', ' ').strip()
                            start_search = idx + len(val)

                        raw_rects.append({
                            "id": str(uuid.uuid4()),
                            "page": page_num,
                            "page_width": p_width,
                            "page_height": p_height,
                            "text": val,
                            "context": f"...{context}...",
                            "category": category,
                            "rect": [area.x0, area.y0, area.x1, area.y1]
                        })
            except Exception:
                pass

        # 2. Deduplicación estricta usando el área completa y el texto
        seen_coordinates = set()
        for r in raw_rects:
            coord_hash = f"{r['page']}_{round(r['rect'][0], 1)}_{round(r['rect'][1], 1)}_{round(r['rect'][2], 1)}_{round(r['rect'][3], 1)}_{r['text']}"
            if coord_hash not in seen_coordinates:
                seen_coordinates.add(coord_hash)
                results.append(r)

    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump({"results": results, "errors": errors}, f)


def apply(input_path, output_path, items):
    """Censura, limpia y verifica. Devuelve el informe que lee server.js.

    Si la verificación final encuentra un término censurado, borra la salida y devuelve
    verified=False: server.js no envía nada.
    """
    doc = fitz.open(input_path)

    # 1. Antes de tocar nada: ' y " explícitos (si no, MuPDF saca el texto de la página).
    normalize_quote_operators(doc)
    # 2. Campos y anotaciones a contenido de página, para que la censura los alcance.
    pending = flatten_document(doc)

    failed_items = []
    applied_count = 0
    zones_by_page = {}
    terms = set()
    for item in items:
        if item.get("category") != MANUAL_CATEGORY:
            t = norm(item.get("text"))
            if len(t) >= MIN_TERM_LEN:
                terms.add(t)
    for page_num, rect in pending:
        zones_by_page.setdefault(page_num, []).append(rect)

    # Blindaje anticaídas con registro de fallos
    for item in items:
        try:
            page = doc[item["page"]]
            rect = fitz.Rect(item["rect"])
            # Forzamos opacidad absoluta en el relleno
            page.add_redact_annot(rect, fill=(0, 0, 0))
            zones_by_page.setdefault(page.number, []).append(rect)
            applied_count += 1
        except Exception as e:
            failed_items.append({"id": item.get("id"), "error": str(e)})
    for page_num, rect in pending:
        doc[page_num].add_redact_annot(rect, fill=(0, 0, 0))

    # Lo que hay bajo cada zona también es un término: cubre las censuras manuales (cuyo
    # "text" es una etiqueta) y el texto real bajo cada hallazgo.
    words_before = {}
    for page in doc:
        zones = zones_by_page.get(page.number, [])
        for s in text_under_zones(page, zones):
            t = norm(s)
            if len(t) >= MIN_TERM_LEN:
                terms.add(t)
        words_before[page.number] = visible_words_outside(page, zones)

    for page in doc:
        if page.number in zones_by_page:
            # CRÍTICO: images=fitz.PDF_REDACT_IMAGE_PIXELS garantiza la destrucción
            # a nivel de píxel del escaneo subyacente. No se puede recuperar el dato tapado.
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)

    remove_outline_terms(doc, terms)

    # Limpieza forense. Todo a True salvo:
    # - redactions: ya aplicadas arriba, con PDF_REDACT_IMAGE_PIXELS.
    # - redact_images: solo afecta a las censuras que aplica scrub (las del texto oculto).
    doc.scrub(
        attached_files=True,
        clean_pages=True,
        embedded_files=True,
        hidden_text=True,
        javascript=True,
        metadata=True,
        redactions=False,
        remove_links=True,
        reset_fields=True,
        reset_responses=True,
        thumbnails=True,
        xml_metadata=True,
    )
    doc.set_metadata({
        "creator": OUTPUT_METADATA["creator"],
        "producer": OUTPUT_METADATA["producer"],
        "author": "",
        "title": "",
        "subject": "",
        "keywords": ""
    })

    doc.save(output_path, garbage=4, deflate=True, clean=True)
    doc.close()

    leaks = verify_redaction(output_path, zones_by_page, terms)
    if leaks:
        os.remove(output_path)
        return {"success": False, "verified": False, "leaks": leaks,
                "applied": applied_count, "failed": failed_items}
    return {"success": True, "verified": True, "applied": applied_count, "failed": failed_items,
            "text_loss_pages": text_loss_pages(output_path, zones_by_page, words_before)}


def main(argv):
    action = argv[1]
    input_path = argv[2]
    if action == "search":
        search(input_path, argv[3], argv[4])
    elif action == "apply":
        output_path = argv[3]
        with open(argv[4], "r", encoding="utf-8") as f:
            items = json.load(f)
        report = apply(input_path, output_path, items)
        if len(argv) > 5:
            with open(argv[5], "w", encoding="utf-8") as f:
                json.dump(report, f)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except Exception as e:
        # Imprimir para que server.js lo capture en el stderr
        print(f"Error crítico en redact.py: {str(e)}", file=sys.stderr)
        sys.exit(1)
