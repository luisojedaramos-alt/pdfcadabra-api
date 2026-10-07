import bisect
import json
import math
import os
import re
import struct
import sys
import unicodedata
import uuid
import zlib
from collections import Counter

import pymupdf as fitz

import pdf_check

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

    Lanza _ContentSyntaxError si el flujo no se puede analizar.
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


def _rewrite_page_contents(doc, page):
    """Reescribe ' y " en el contenido de la página, analizado ya unido: los flujos de
    /Contents son un único contenido partido por donde sea entre dos tokens (el operando
    de un ' puede estar en un flujo y el operador en el siguiente). True si cambió algo."""
    xrefs = page.get_contents()
    streams = [doc.xref_stream(x) or b"" for x in xrefs]
    new = rewrite_quote_operators(b"\n".join(streams))
    if new is None:
        return False
    if len(xrefs) == 1:
        doc.update_stream(xrefs[0], new)
        return True
    # Si ningún operador cruza de un flujo a otro, cada flujo se reescribe por separado,
    # como antes; si no, la página pasa a tener un único flujo con el contenido unido.
    try:
        parts = [rewrite_quote_operators(s) for s in streams]
    except _ContentSyntaxError:
        parts = None
    if parts is not None and b"\n".join(p if p is not None else s for p, s in zip(parts, streams)) == new:
        for x, p in zip(xrefs, parts):
            if p is not None:
                doc.update_stream(x, p)
        return True
    joined = doc.get_new_xref()
    doc.update_object(joined, "<<>>")
    doc.update_stream(joined, new)
    doc.xref_set_key(page.xref, "Contents", f"{joined} 0 R")
    return True


def normalize_quote_operators(doc):
    """Reescribe ' y " en los contenidos de página y en los Form XObjects.

    Devuelve cuántos contenidos se reescribieron. Lanza _ContentSyntaxError si alguno con
    ' o " no se puede analizar: no se puede saber si MuPDF sacaría el texto de la página
    ni dónde quedaría, así que no se censura.
    """
    rewritten = 0
    for page in doc:
        rewritten += _rewrite_page_contents(doc, page)
    for xref in range(1, doc.xref_length()):
        try:
            if not (doc.xref_is_stream(xref) and doc.xref_get_key(xref, "Subtype") == ("name", "/Form")):
                continue
        except Exception:
            continue
        data = doc.xref_stream(xref)
        new = rewrite_quote_operators(data) if data else None
        if new is not None:
            doc.update_stream(xref, new)
            rewritten += 1
    return rewritten


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


def compact_xref(doc):
    """doc.scrub() aborta ("bad xref - clean PDF before scrubbing") si la tabla xref tiene
    huecos: números de objeto sin objeto, algo válido en un PDF (p. ej. tras una
    actualización incremental o al quitar objetos al unir). En ese caso se reabre el
    documento serializado con garbage=3, que renumera los objetos sin huecos."""
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_object(xref):
                continue
        except Exception:
            pass
        compact = fitz.open("pdf", doc.tobytes(garbage=3))
        doc.close()
        return compact
    return doc


# ==========================================
# 3. TEXTO Y TÉRMINOS
# ==========================================
def norm(s):
    """Forma comparable de un texto: NFC, minúsculas y espacios simples."""
    s = unicodedata.normalize("NFC", s or "").casefold()
    return re.sub(r"\s+", " ", s).strip()


class ZoneIndex:
    """Zonas de una página ordenadas por y0, para no comparar cada palabra con todas."""

    def __init__(self, zones, margin=0.0):
        self.zones = sorted(
            (fitz.Rect(z.x0 - margin, z.y0 - margin, z.x1 + margin, z.y1 + margin) for z in zones),
            key=lambda z: z.y0,
        )
        self.y0s = [z.y0 for z in self.zones]
        self.max_h = max((z.height for z in self.zones), default=0)

    def candidates(self, y0, y1):
        """Zonas que pueden solaparse verticalmente con [y0, y1]."""
        lo = bisect.bisect_left(self.y0s, y0 - self.max_h)
        hi = bisect.bisect_right(self.y0s, y1)
        return [z for z in self.zones[lo:hi] if z.y1 >= y0]

    def touches(self, r):
        return any(r.intersects(z) for z in self.candidates(r.y0, r.y1))

    def containing_point(self, x, y):
        return [z for z in self.candidates(y, y) if z.x0 <= x <= z.x1]


def page_words(page):
    """Palabras de la página como [(texto, Rect)], de get_text("words") (en C, rápido).

    Incluye el texto invisible (la capa de un OCR): scrub se llama con hidden_text=False,
    así que también debe conservarse fuera de las zonas.
    """
    return [(text, fitz.Rect(x0, y0, x1, y1)) for x0, y0, x1, y1, text, *_ in page.get_text("words")]


def chars_in_zones(page, zones):
    """¿Queda algún carácter con el centro dentro de una zona censurada?

    Primero, con las palabras, se buscan las que tocan una zona (tras una censura correcta,
    solo las vecinas). Solo si hay alguna se mira carácter a carácter (rawdict, más lento).
    """
    if not zones:
        return False
    index = ZoneIndex(zones)
    if not any(index.touches(r) for _, r in page_words(page)):
        return False
    for block in page.get_text("rawdict").get("blocks", ()):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", ()):
            for span in line.get("spans", ()):
                for ch in span.get("chars", ()):
                    if ch["c"].isspace():
                        continue
                    x0, y0, x1, y1 = ch["bbox"]
                    if index.containing_point((x0 + x1) / 2, (y0 + y1) / 2):
                        return True
    return False


_ALL_TEXT_FLAGS = fitz.TEXTFLAGS_WORDS & ~fitz.TEXT_MEDIABOX_CLIP


def _word_key(word):
    x0, y0, x1, y1, text, *_ = word
    return (text, round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1))


def hidden_words(page_visible, page_all):
    """Palabras de la página que no se ven, como [(texto, Rect)]: fuera del CropBox o del
    MediaBox, desplazadas fuera de la página o en una capa OCG apagada. `page_all` es la
    misma página extraída sin recorte y con todas las capas visibles (documento sin
    /OCProperties).

    Cada palabra visible (misma posición y texto) descuenta una de `page_all`; lo que queda
    es el texto oculto, en el orden de la página. Las palabras llegan sin girar: la zona
    visible es page.rect * derotation_matrix (con page.rect, en una página a 90 o 270 grados
    el texto visible de abajo contaba como oculto).
    """
    shown = page_visible.rect * page_visible.derotation_matrix
    visible = Counter(_word_key(w) for w in page_visible.get_text("words", clip=shown))
    hidden = []
    for w in page_all.get_text("words", clip=fitz.INFINITE_RECT(), flags=_ALL_TEXT_FLAGS):
        key = _word_key(w)
        if visible[key]:
            visible[key] -= 1
        else:
            hidden.append((w[4], fitz.Rect(w[:4])))
    return hidden


def hidden_page_text(page_visible, page_all):
    """El texto oculto de la página (hidden_words) en una cadena."""
    return " ".join(w for w, _ in hidden_words(page_visible, page_all))


def hidden_term_rects(page_visible, page_all, terms):
    """Rectángulos de las palabras ocultas que forman parte de un término.

    Se busca igual que en la verificación (cada término en el texto oculto normalizado y
    unido por espacios), así que lo que queda tras censurar estas palabras ya no contiene
    ningún término. Se censura la palabra entera: no se ve.
    """
    words = hidden_words(page_visible, page_all)
    if not words or not terms:
        return []
    normed = [norm(w) for w, _ in words]
    starts, pos = [], 0
    for w in normed:
        starts.append(pos)
        pos += len(w) + 1
    joined = " ".join(normed)
    hit = set()
    for t in terms:
        i = joined.find(t)
        while i != -1:
            hit.update(range(bisect.bisect_right(starts, i) - 1, bisect.bisect_left(starts, i + len(t))))
            i = joined.find(t, i + 1)
    return [words[k][1] for k in sorted(hit)]


def open_all_layers(path):
    """`path` abierto con todas las capas visibles: sin /OCProperties MuPDF no oculta ningún
    contenido opcional (activar las capas no basta: un OCMD /AllOff se ocultaría). Hay que
    reabrirlo (cambiar la clave en memoria no basta), así que se guarda una copia junto a
    `path`, en disco y no en memoria. Devuelve (documento, ruta de la copia o None)."""
    doc = fitz.open(path)
    if doc.xref_get_key(doc.pdf_catalog(), "OCProperties")[0] == "null":
        return doc, None
    copy_path = path + ".capas.pdf"
    doc.xref_set_key(doc.pdf_catalog(), "OCProperties", "null")
    doc.save(copy_path)
    doc.close()
    return fitz.open(copy_path), copy_path


def text_under_zones(words, zones):
    """Texto bajo cada zona (palabras con el centro dentro), una cadena por zona."""
    index = ZoneIndex(zones)
    by_zone = {}
    for w, r in words:
        for z in index.containing_point((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2):
            by_zone.setdefault(id(z), []).append(w)
    return [" ".join(ws) for ws in by_zone.values()]


def words_outside(words, zones, margin=1.0):
    """Palabras que no tocan ninguna zona: deben sobrevivir a la censura."""
    index = ZoneIndex(zones, margin)
    return Counter(w for w, r in words if not index.touches(r))


# ==========================================
# 4. RECOMPRESIÓN DE LAS IMÁGENES CENSURADAS
# ==========================================
# apply_redactions(PDF_REDACT_IMAGE_PIXELS) sustituye cada imagen que toca una zona por una
# copia nueva SIN comprimir (con save(deflate=True) acaba en Flate): un escaneo JPEG en gris
# pasaba de 24 a 67 MB y uno en color se multiplicaba por 5. Aquí se vuelve a codificar cada
# imagen sustituida como su original: JPEG (o JPEG 2000) en JPEG con la calidad estimada del
# original, y 1 bit (CCITT, JBIG2...) en CCITT G4 sin pérdida. Los píxeles tapados ya son
# negros en la copia, así que recomprimir no puede devolver nada de lo censurado.

# Tabla de cuantización de luminancia de referencia (IJG, calidad 50).
_STD_LUMA_SUM = sum((
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
))
DEFAULT_JPEG_QUALITY = 85
# Con estos colores o menos, una imagen censurada nunca pasa a JPEG.
MAX_LOSSLESS_COLORS = 16


def jpeg_quality(data):
    """Calidad IJG aproximada (30-95) de un JPEG, por su tabla de luminancia; None si no hay."""
    i = 2
    try:
        while i + 4 <= len(data) and data[i] == 0xFF:
            marker = data[i + 1]
            length = struct.unpack(">H", data[i + 2:i + 4])[0]
            if marker == 0xDB:
                seg = data[i + 4:i + 2 + length]
                j = 0
                while j < len(seg):
                    precision, table = seg[j] >> 4, seg[j] & 15
                    size = 128 if precision else 64
                    values = seg[j + 1:j + 1 + size]
                    if precision:
                        values = struct.unpack(">64H", values)
                    if table == 0:
                        scale = sum(values) * 100 / _STD_LUMA_SUM
                        q = (200 - scale) / 2 if scale <= 100 else 5000 / scale
                        return max(30, min(95, round(q)))
                    j += 1 + size
            if marker == 0xDA:  # empiezan los datos: no hay más tablas
                return None
            i += 2 + length
    except (struct.error, IndexError):
        return None
    return None


def _image_places(page, xrefs):
    """{xref: posiciones redondeadas} de esas imágenes en la página.

    Por la huella MD5 de los píxeles, como get_image_rects, pero con un TextPage nuevo:
    get_image_info/get_image_rects guardan en caché las imágenes de antes de censurar.
    Decodifica cada imagen: solo se usa cuando hay varias del mismo tamaño.
    """
    by_digest = {}
    for info in page.get_textpage(flags=fitz.TEXT_PRESERVE_IMAGES).extractIMGINFO(hashes=True):
        by_digest.setdefault(info["digest"], []).append(tuple(round(v) for v in info["bbox"]))
    return {x: tuple(sorted(by_digest.get(fitz.Pixmap(page.parent, x).digest, []))) for x in xrefs}


def _image_slots(page):
    """Imágenes de la página: [(xref, ancho, alto, bits por componente, /Filter, posiciones)].

    El /Filter completo ("null" si no tiene, "[/FlateDecode/DCTDecode]"...): get_images solo
    da el primer filtro de la cadena. Posiciones: dónde se dibuja (la copia que deja
    apply_redactions va en el mismo sitio que su original), solo para las imágenes que
    comparten ancho, alto y bits con otra; para el resto, ().
    """
    doc = page.parent
    slots = [(im[0], im[2], im[3], im[4], doc.xref_get_key(im[0], "Filter")[1])
             for im in page.get_images(full=True)]
    sizes = Counter(s[1:4] for s in slots)
    ambiguous = [s[0] for s in slots if sizes[s[1:4]] > 1]
    places = _image_places(page, ambiguous) if ambiguous else {}
    return [s + (places.get(s[0], ()),) for s in slots]


def _encode_g4(doc, xref, width, height):
    """Imagen de 1 bit sin comprimir -> CCITT G4. True si los bits decodificados son idénticos."""
    raw = doc.xref_stream(xref)
    stride = (width + 7) // 8
    if not raw or len(raw) != stride * height:
        return False
    buf = fitz.mupdf.fz_compress_ccitt_fax_g4(fitz.mupdf.python_buffer_data(raw), width, height, stride)
    encoded = buf.fz_buffer_extract()
    doc.update_stream(xref, encoded, compress=False)
    doc.xref_set_key(xref, "Filter", "/CCITTFaxDecode")
    doc.xref_set_key(xref, "DecodeParms", f"<</K -1 /Columns {width} /Rows {height}>>")
    if doc.xref_stream(xref) == raw:
        # En 1 bit, el gris ICC que pone MuPDF equivale a DeviceGray y ahorra el perfil (~3 KB).
        # Las máscaras (ImageMask) no llevan espacio de color.
        if doc.xref_get_key(xref, "ImageMask")[1] != "true":
            doc.xref_set_key(xref, "ColorSpace", "/DeviceGray")
        return True
    # No debería pasar: se vuelve a la copia sin pérdida.
    doc.update_stream(xref, raw)
    doc.xref_set_key(xref, "DecodeParms", "null")
    return False


def _encode_jpeg(doc, xref, original_xref, original_filter):
    """Imagen de 8 bits gris o RGB sin comprimir -> JPEG con la calidad del original."""
    pix = fitz.Pixmap(doc, xref)
    if pix.alpha or pix.n not in (1, 3):
        return False  # CMYK u otros: se queda sin pérdida (Flate)
    if pix.color_count() <= MAX_LOSSLESS_COLORS:
        # Código de barras, QR o sello (o una Indexed que MuPDF ha pasado a RGB): sin pérdida,
        # aunque se haya emparejado con un JPEG (como en Comprimir, lossless_images.py).
        return False
    quality = None
    if "DCT" in original_filter:
        try:
            quality = jpeg_quality(doc.extract_image(original_xref)["image"])
        except Exception:
            quality = None
    jpeg = pix.tobytes("jpg", jpg_quality=quality or DEFAULT_JPEG_QUALITY)
    if "DCT" not in original_filter:
        # JPEG 2000: sin calidad que copiar; si Flate sin pérdida ocupa menos, se queda en Flate.
        raw = doc.xref_stream(xref)
        if len(zlib.compress(raw, 6)) <= len(jpeg):
            return False
    wrapped = zlib.compress(jpeg, 9)
    if len(wrapped) < len(jpeg):  # como jpeg_flate.py: la capa Flate, si ahorra
        doc.update_stream(xref, wrapped, compress=False)
        doc.xref_set_key(xref, "Filter", "[/FlateDecode /DCTDecode]")
    else:
        doc.update_stream(xref, jpeg, compress=False)
        doc.xref_set_key(xref, "Filter", "/DCTDecode")
    doc.xref_set_key(xref, "DecodeParms", "null")
    doc.xref_set_key(xref, "BitsPerComponent", "8")
    return True


def recompress_redacted_images(doc, page, before):
    """Recomprime las imágenes que apply_redactions acaba de sustituir en `page`.

    `before`: _image_slots(page) antes de censurar. Devuelve cuántas se recomprimieron.
    """
    done = 0
    after = _image_slots(page)
    after_xrefs = {b[0] for b in after}
    before_xrefs = {b[0] for b in before}
    # La copia nueva cambia de xref y de nombre de recurso: se empareja con la imagen que ha
    # desaparecido de la página y tiene las mismas dimensiones y bits por componente (en un
    # escaneo, el fondo en color y la máscara de texto suelen medir lo mismo) y, si hay
    # varias, con la que se dibujaba en el mismo sitio: por orden, un QR podía emparejarse con
    # la foto JPEG de al lado y salir en JPEG.
    # (Si alguna no se encuentra por su sitio, después se empareja por orden, como antes.)
    replaced = [b for b in before if b[0] not in after_xrefs]
    copies = [a for a in after if a[0] not in before_xrefs and a[4] == "null"]  # nuevas, sin comprimir
    pairs = []
    for by_place in (True, False):
        for copy in list(copies):
            match = next((b for b in replaced if b[1:4] == copy[1:4] and (b[5] == copy[5] or not by_place)), None)
            if match is not None:
                replaced.remove(match)
                copies.remove(copy)
                pairs.append((copy, match))
    for (xref, width, height, bits, _, _), match in pairs:
        original_xref, original_filter = match[0], match[4]
        bpc = doc.xref_get_key(xref, "BitsPerComponent")[1]
        try:
            if bpc == "1":
                ok = _encode_g4(doc, xref, width, height)
            elif bpc == "8" and ("DCT" in original_filter or "JPX" in original_filter):
                ok = _encode_jpeg(doc, xref, original_xref, original_filter)
            else:
                ok = False
        except Exception as e:  # nunca tumba la censura: la imagen queda sin pérdida
            print(f"Aviso en redact.py: no se pudo recomprimir una imagen: {e}", file=sys.stderr)
            ok = False
        done += ok
    return done


# ==========================================
# 5. MARCADORES
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
# 6. ADJUNTOS POR /AF
# ==========================================
def remove_associated_files(doc):
    """Quita /AF (archivos asociados: PDF/A-3, Factur-X) de todos los objetos que lo tengan.

    scrub(embedded_files=True) vacía el árbol de nombres /EmbeddedFiles, pero un adjunto
    también puede colgar de /AF (del catálogo, de una página...), con o sin entrada en el
    árbol. Se tratan igual que los del árbol: fuera. Sin referencias, el Filespec y su
    flujo se quedan huérfanos y save(garbage=4) los elimina.
    """
    removed = 0
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(xref, "AF")[0] == "null":
                continue
        except Exception:
            continue
        doc.xref_set_key(xref, "AF", "null")
        removed += 1
    return removed


# ==========================================
# 7. CADENAS CON UN TÉRMINO FUERA DE LA PÁGINA (capas, acciones, estructura...)
# ==========================================
# Se recorren los objetos con la API de MuPDF. Las cadenas se comparan con term_matcher,
# el mismo criterio que el barrido final (objects_with_terms): lo que se limpia aquí es
# exactamente lo que la verificación daría por fuga.
_m = fitz.mupdf


def _catalog(doc):
    return _m.pdf_dict_get(_m.pdf_trailer(fitz._as_pdf_document(doc)), _m.PDF_ENUM_NAME_Root)


def _string_bytes(obj):
    """Bytes de una cadena PDF (pdf_to_string corta en el primer byte nulo)."""
    src = fitz.JM_object_to_buffer(_m.pdf_resolve_indirect(obj), 1, 0).fz_buffer_extract()
    return b"".join(_pdf_strings(src.decode("latin-1")))


# No se sigue hacia el padre ni hacia la página: se saldría del objeto que se examina.
_UPWARD_KEYS = {"Parent", "P"}


def _walk_strings(obj, pages, seen):
    """(contenedor, clave o índice, cadena) de cada cadena de obj y de lo que referencia,
    salvo páginas y Parent/P. `seen`: números de objeto ya visitados."""
    if _m.pdf_is_indirect(obj):
        num = _m.pdf_to_num(obj)
        if num in pages or num in seen:
            return
        seen.add(num)
    if _m.pdf_is_array(obj):
        for i in range(_m.pdf_array_len(obj)):
            item = _m.pdf_array_get(obj, i)
            if _m.pdf_is_string(item):
                yield obj, i, item
            else:
                yield from _walk_strings(item, pages, seen)
    elif _m.pdf_is_dict(obj):
        for i in range(_m.pdf_dict_len(obj)):
            key = _m.pdf_dict_get_key(obj, i)
            if _m.pdf_to_name(key) in _UPWARD_KEYS:
                continue
            val = _m.pdf_dict_get_val(obj, i)
            if _m.pdf_is_string(val):
                yield obj, key, val
            else:
                yield from _walk_strings(val, pages, seen)


def _has_term(obj, found, pages):
    """¿Alguna cadena de obj, o de lo que referencia (salvo páginas y Parent/P), contiene
    un término?"""
    return any(found(_string_bytes(s)) for _, _, s in _walk_strings(obj, pages, set()))


def _blank_term_strings(obj, found, pages):
    """Vacía cada cadena con un término de obj y de lo que referencia. Devuelve cuántas."""
    hits = [(c, k) for c, k, s in _walk_strings(obj, pages, set()) if found(_string_bytes(s))]
    for container, key in hits:
        empty = _m.pdf_new_text_string("")
        if _m.pdf_is_array(container):
            _m.pdf_array_put(container, key, empty)
        else:
            _m.pdf_dict_put(container, key, empty)
    return len(hits)


def clean_layer_names(doc, found):
    """Capas OCG: el nombre de una capa con un término pasa a "Capa N"; cualquier otra
    cadena con un término en /OCProperties (nombre de configuración, etiquetas de /Order,
    /Usage de las capas...) se vacía. Devuelve cuántas cadenas cambió."""
    pages = {p.xref for p in doc}
    changed = layer = 0
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(xref, "Type") != ("name", "/OCG"):
                continue
        except Exception:
            continue
        layer += 1
        ocg = _m.pdf_load_object(fitz._as_pdf_document(doc), xref)
        name = _m.pdf_dict_gets(ocg, "Name")
        if _m.pdf_is_string(name) and found(_string_bytes(name)):
            _m.pdf_dict_puts(ocg, "Name", _m.pdf_new_text_string(f"Capa {layer}"))
            changed += 1
        changed += _blank_term_strings(ocg, found, pages)
    ocp = _m.pdf_dict_gets(_catalog(doc), "OCProperties")
    if _m.pdf_is_dict(ocp):
        changed += _blank_term_strings(ocp, found, pages)
    return changed


# ==========================================
# 8. VERIFICACIÓN FINAL
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


# Barrido de objetos: guiones y espacios no cuentan ("12345678-Z" = "12345678 Z" = "12345678Z").
_SEPARATORS = re.compile(r"[\s\-‐-―−­]+")
_ESCAPES = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12}


def _compact(s):
    return _SEPARATORS.sub("", norm(s))


def _pdf_strings(source):
    """Cadenas literales y hexadecimales (como bytes) de un objeto en sintaxis PDF."""
    out = []
    i, n = 0, len(source)
    while i < n:
        c = source[i]
        if c == "(":
            buf, depth, i = bytearray(), 1, i + 1
            while i < n:
                c = source[i]
                if c == "\\" and i + 1 < n:
                    e = source[i + 1]
                    if e in "01234567":
                        j = i + 1
                        while j < n and j < i + 4 and source[j] in "01234567":
                            j += 1
                        buf.append(int(source[i + 1:j], 8) & 0xFF)
                        i = j
                        continue
                    if e in "\r\n":  # continuación de línea
                        i += 3 if source[i + 1:i + 3] == "\r\n" else 2
                        continue
                    buf.append(_ESCAPES.get(ord(e), ord(e) & 0xFF))
                    i += 2
                    continue
                if c == "(":
                    depth += 1
                elif c == ")":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                buf.append(ord(c) & 0xFF)
                i += 1
            out.append(bytes(buf))
        elif c == "<" and source.startswith("<<", i):
            i += 2
        elif c == "<":
            k = source.find(">", i)
            if k == -1:
                break
            digits = re.sub(r"[^0-9A-Fa-f]", "", source[i + 1:k])
            out.append(bytes.fromhex(digits + "0" * (len(digits) % 2)))
            i = k + 1
        else:
            i += 1
    return out


def _texts(data):
    """Lecturas posibles de unos bytes: PDFDocEncoding/latin-1, UTF-8 y UTF-16 (con o sin
    BOM; sin BOM, el latin-1 sin los bytes nulos cubre el ASCII en UTF-16BE y LE)."""
    texts = []
    if data[:2] in (b"\xfe\xff", b"\xff\xfe"):
        try:
            texts.append(data.decode("utf-16"))
        except UnicodeDecodeError:
            pass
    latin = data.decode("latin-1")
    texts += [latin, latin.replace("\x00", "")]
    try:
        texts.append(data.decode("utf-8-sig"))
    except UnicodeDecodeError:
        pass
    if len(data) % 2 == 0 and b"\x00" in data:
        for enc in ("utf-16-be", "utf-16-le"):
            try:
                texts.append(data.decode(enc))
            except UnicodeDecodeError:
                pass
    return texts


def _excluded_streams(doc):
    """Flujos que el barrido no lee: contenidos (página, Form XObjects, patrones, glifos
    Type3: el texto de página se verifica por geometría y por texto oculto), fuentes y sus
    CMaps, e imágenes y perfiles ICC (binarios: un término corto aparecería por azar)."""
    excluded = set()
    for page in doc:
        excluded.update(page.get_contents())

    def ref(value):
        kind, v = value
        return int(v.split()[0]) if kind == "xref" else None

    for xref in range(1, doc.xref_length()):
        try:
            typ = doc.xref_get_key(xref, "Type")[1]
            subtype = doc.xref_get_key(xref, "Subtype")[1]
            if typ == "/Font":
                for key in ("ToUnicode", "Encoding", "CIDToGIDMap"):
                    x = ref(doc.xref_get_key(xref, key))
                    if x:
                        excluded.add(x)
                procs = doc.xref_get_key(xref, "CharProcs")  # glifos Type3
                if procs[0] == "xref":
                    procs = ("dict", doc.xref_object(ref(procs)))
                if procs[0] == "dict":
                    excluded.update(int(m) for m in re.findall(r"(\d+) 0 R", procs[1]))
            elif typ == "/FontDescriptor":
                for key in ("FontFile", "FontFile2", "FontFile3", "CIDSet"):
                    x = ref(doc.xref_get_key(xref, key))
                    if x:
                        excluded.add(x)
            if not doc.xref_is_stream(xref):
                continue
            if (subtype in ("/Form", "/Image") or typ in ("/Pattern", "/CMap", "/ObjStm", "/XRef")
                    or doc.xref_get_key(xref, "PatternType")[0] != "null"
                    or doc.xref_get_key(xref, "ShadingType")[0] != "null"
                    or doc.xref_get_key(xref, "FunctionType")[0] != "null"):
                excluded.add(xref)
            elif doc.xref_get_key(xref, "N")[0] == "int" and (doc.xref_stream(xref) or b"")[36:40] == b"acsp":
                excluded.add(xref)  # perfil ICC
        except Exception:
            continue
    return excluded


_FONT_OBJECTS = ("/Font", "/FontDescriptor", "/Encoding")


def term_matcher(terms):
    """Función bytes -> bool: ¿contienen esos bytes un término, sin contar guiones ni
    espacios y en cualquiera de las lecturas de _texts? Las cadenas que escribimos nosotros
    (OUTPUT_METADATA) no cuentan. None si no hay términos que buscar fuera de la página."""
    compact_terms = {c for c in (_compact(t) for t in terms) if len(c) >= MIN_TERM_LEN}
    if not compact_terms:
        return None
    ours = {_compact(v) for v in OUTPUT_METADATA.values()}

    def found(data):
        for text in _texts(data):
            c = _compact(text)
            if c and c not in ours and any(t in c for t in compact_terms):
                return True
        return False

    return found


def objects_with_terms(doc, terms):
    """¿Aparece un término (sin contar guiones ni espacios) en algún objeto del PDF?

    Recorre todos los objetos descomprimidos (también los de object streams): las cadenas
    literales y hexadecimales de cada diccionario o array, y el contenido de los flujos que
    no son contenido de página, fuentes ni imágenes. Las cadenas que escribimos nosotros
    (OUTPUT_METADATA) no cuentan.
    """
    found = term_matcher(terms)
    if found is None:
        return False
    excluded = _excluded_streams(doc)

    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(xref, "Type")[1] in _FONT_OBJECTS:
                continue
            source = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        if any(found(s) for s in _pdf_strings(source)):
            return True
        if xref not in excluded and doc.xref_is_stream(xref) and found(doc.xref_stream(xref) or b""):
            return True
    return False


def verify_redaction(path, zones_by_page, terms):
    """Busca de nuevo en el PDF de salida. Devuelve la lista de sitios con fugas.

    - Texto de página visible: ningún carácter puede tener el centro dentro de una zona
      censurada (geometría: una aparición visible que el usuario decidió no censurar no es
      una fuga).
    - Texto de página oculto (fuera del CropBox o del MediaBox, desplazado fuera de la
      página o en una capa apagada): no puede aparecer ningún término censurado. El
      usuario no lo ha visto, así que no ha podido decidir dejarlo.
    - Campos, anotaciones, enlaces, metadatos (Info y XMP), marcadores y adjuntos: no
      puede aparecer ningún término censurado.
    Nunca devuelve los términos: el resultado va al log.
    """
    leaks = set()
    doc = fitz.open(path)
    all_layers, copy_path = open_all_layers(path)
    try:
        for page in doc:
            if chars_in_zones(page, zones_by_page.get(page.number)):
                leaks.add("page_text")
            if _contains_term(hidden_page_text(page, all_layers[page.number]), terms):
                leaks.add("hidden_text")
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

        # Todo lo demás (adjuntos por /AF, /Names /Dests, acciones URI, StructTreeRoot,
        # capas, /PieceInfo, /PageLabels, /Threads...): cualquier objeto con un término.
        if objects_with_terms(doc, terms):
            leaks.add("pdf_objects")
    finally:
        doc.close()
        all_layers.close()
        if copy_path:
            os.remove(copy_path)
    return sorted(leaks)


def text_loss_pages(path, zones_by_page, words_before):
    """Páginas (desde 1) que han perdido texto (visible u OCR) fuera de las zonas censuradas."""
    doc = fitz.open(path)
    try:
        return [
            page.number + 1
            for page in doc
            if words_before.get(page.number, Counter())
            - words_outside(page_words(page), zones_by_page.get(page.number, []))
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


def item_zone(doc, item):
    """(página, Rect) de un hallazgo; ValueError si no se puede censurar tal cual.

    Un rectángulo invertido o vacío no tapa nada aunque MuPDF lo acepte, y uno fuera de la
    página tampoco: se dan por censura fallida (y server.js no entrega nada). Tampoco vale
    una página negativa (en Python, -1 sería la última). Los hallazgos llegan en
    coordenadas de la página sin girar, como los da search_for.
    """
    number = item["page"]
    if not isinstance(number, int) or isinstance(number, bool) or not 0 <= number < doc.page_count:
        raise ValueError(f"page {number} not in document")
    page = doc[number]
    coords = [float(v) for v in item["rect"]]
    if len(coords) != 4 or not all(math.isfinite(v) for v in coords):
        raise ValueError("rect no válido")
    x0, y0, x1, y1 = coords
    if x0 >= x1 or y0 >= y1:
        raise ValueError("rect invertido o vacío")
    rect = fitz.Rect(coords)
    if not rect.intersects(page.rect * page.derotation_matrix):
        raise ValueError("rect fuera de la página")
    return page, rect


def apply(input_path, output_path, items):
    """Censura, limpia y verifica. Devuelve el informe que lee server.js.

    Si la verificación final encuentra un término censurado, borra la salida y devuelve
    verified=False: server.js no envía nada.
    """
    doc = fitz.open(input_path)

    # 1. Antes de tocar nada: ' y " explícitos (si no, MuPDF saca el texto de la página).
    # Un contenido con ' o " que no se puede analizar no se censura: server.js responde 422.
    try:
        normalize_quote_operators(doc)
    except _ContentSyntaxError:
        doc.close()
        return {"success": False, "verified": False, "leaks": ["content_syntax"],
                "applied": 0, "failed": []}
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
            page, rect = item_zone(doc, item)
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
        words = page_words(page)
        for s in text_under_zones(words, zones):
            t = norm(s)
            if len(t) >= MIN_TERM_LEN:
                terms.add(t)
        words_before[page.number] = words_outside(words, zones)

    # Texto oculto con un término (decisión de Luis, 2026-10-07): se censura siempre,
    # porque el usuario no lo ve y no ha podido decidir dejarlo. Se busca antes de
    # censurar, en el documento tal como lo vio el usuario. Con capas OCG, las palabras de
    # todas las capas salen de una copia en disco sin /OCProperties (como en la verificación).
    hidden_by_page = {}
    if terms:
        all_layers, copy_path, snapshot = doc, None, None
        if doc.xref_get_key(doc.pdf_catalog(), "OCProperties")[0] != "null":
            snapshot = output_path + ".pre.pdf"
            doc.save(snapshot)
        try:
            if snapshot:
                all_layers, copy_path = open_all_layers(snapshot)
            for page in doc:
                rects = hidden_term_rects(page, all_layers[page.number], terms)
                if rects:
                    hidden_by_page[page.number] = rects
        finally:
            if all_layers is not doc:
                all_layers.close()
            for p in (snapshot, copy_path):
                if p and os.path.exists(p):
                    os.remove(p)

    for page in doc:
        if page.number in zones_by_page:
            # CRÍTICO: images=fitz.PDF_REDACT_IMAGE_PIXELS garantiza la destrucción
            # a nivel de píxel del escaneo subyacente. No se puede recuperar el dato tapado.
            before = _image_slots(page)
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
            recompress_redacted_images(doc, page, before)
        if page.number in hidden_by_page:
            # Solo el texto y sin relleno: la zona no se ve, y no debe tocar imágenes ni
            # trazos que sí se vean (un fondo de página que llega fuera del CropBox). Estas
            # zonas no van a zones_by_page: si se llevaran texto visible, text_loss_pages
            # lo avisa.
            for rect in hidden_by_page[page.number]:
                page.add_redact_annot(rect, fill=False)
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)

    remove_outline_terms(doc, terms)
    doc = compact_xref(doc)

    # Limpieza forense. Todo a True salvo:
    # - hidden_text: conserva la capa de texto invisible de un OCR (si no, un expediente
    #   escaneado deja de poder buscarse). Lo que hay bajo las zonas ya lo ha borrado
    #   apply_redactions (también el texto invisible) y lo comprueba verify_redaction.
    # - redactions: ya aplicadas arriba, con PDF_REDACT_IMAGE_PIXELS.
    # - redact_images: no se pasa; solo afectaría a las censuras que aplicase scrub.
    doc.scrub(
        attached_files=True,
        clean_pages=True,
        embedded_files=True,
        hidden_text=False,
        javascript=True,
        metadata=True,
        redactions=False,
        remove_links=True,
        reset_fields=True,
        reset_responses=True,
        thumbnails=True,
        xml_metadata=True,
    )
    remove_associated_files(doc)
    found = term_matcher(terms)
    if found is not None:
        clean_layer_names(doc, found)
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
    # Con contraseña de apertura no se busca ni se censura nada: server.js responde 422
    # PDF_ENCRYPTED. Los de solo propietario se abren con la contraseña vacía y siguen.
    if pdf_check.needs_password(fitz.open(input_path)):
        print("PDF con contraseña de apertura", file=sys.stderr)
        sys.exit(pdf_check.EXIT_ENCRYPTED)
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
