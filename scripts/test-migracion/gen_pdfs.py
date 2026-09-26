"""Genera los PDF sintéticos (sin datos reales) de scripts/test-migracion/run.sh.

- escaneo.pdf: estructura de un escaneo de juzgado. Cada página lleva un fondo JPEG
  en color a 150 ppp con Filter [/FlateDecode /DCTDecode] (el caso que trata
  jpeg_flate.py) y encima una capa de texto en B/N CCITT G4 a 300 ppp (ImageMask).
  Sin texto extraíble, como un escaneo real.
- texto.pdf: texto Helvetica con datos personales ficticios (DNI, correo, teléfono,
  IBAN de ejemplo) para Anonimizar, más una foto JPEG a 300 ppp que los niveles
  extremo y recomendado deben reducir.

Solo necesita Pillow. Uso: python gen_pdfs.py <carpeta_salida>
"""
import io
import random
import sys
import unicodedata
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

PAGE_W, PAGE_H = 595, 842  # A4 en puntos
SEED = 20260926  # determinista: el mismo PDF en cada ejecución y en cada lado

PARRAFOS = [
    "JUZGADO DE PRIMERA INSTANCIA NÚMERO 0 DE EJEMPLO",
    "Procedimiento ordinario 0000/2026 - Documento sintético de prueba",
    "",
    "En la ciudad de Ejemplo, a veintiséis de septiembre de dos mil veintiséis.",
    "Vistos por el magistrado los presentes autos de juicio ordinario seguidos",
    "a instancia de la parte actora, representada por el procurador de prueba y",
    "asistida por el letrado de prueba, contra la parte demandada, sobre",
    "reclamación de cantidad, se dicta la presente resolución de prueba.",
    "",
    "ANTECEDENTES DE HECHO",
    "PRIMERO.- Por turno de reparto correspondió a este juzgado la demanda",
    "presentada, en la que tras alegar los hechos y fundamentos de derecho que",
    "estimó oportunos, terminaba suplicando que se dictase sentencia estimatoria.",
    "SEGUNDO.- Admitida a trámite la demanda, se emplazó a la parte demandada",
    "para que compareciese y contestase en el plazo de veinte días hábiles.",
    "TERCERO.- En la tramitación de este procedimiento se han observado las",
    "prescripciones legales, salvo el plazo para dictar resolución.",
    "",
    "FUNDAMENTOS DE DERECHO",
    "PRIMERO.- Este texto es íntegramente ficticio y solo sirve para medir la",
    "compresión de un escaneo en blanco y negro sobre un fondo en color.",
]


def jpeg_bytes(img, quality, dpi):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, dpi=(dpi, dpi))
    return buf.getvalue()


def g4_bytes(img):
    """Codifica una imagen 1 bit en CCITT G4 (una sola tira) y devuelve el flujo crudo."""
    buf = io.BytesIO()
    img.save(buf, "TIFF", compression="group4", strip_size=10**9)
    tif = Image.open(io.BytesIO(buf.getvalue()))
    offsets, counts = tif.tag_v2[273], tif.tag_v2[279]
    if len(offsets) != 1:
        raise RuntimeError(f"G4: se esperaba 1 tira, hay {len(offsets)}")
    raw = buf.getvalue()
    return raw[offsets[0] : offsets[0] + counts[0]]


class Pdf:
    """Escritor mínimo de PDF: objetos numerados, xref clásica y trailer."""

    def __init__(self):
        self.objs = []

    def add(self, body):
        self.objs.append(body)
        return len(self.objs)

    def stream(self, entries, data):
        head = f"<< {entries} /Length {len(data)} >>\nstream\n".encode("latin-1")
        return self.add(head + data + b"\nendstream")

    def save(self, path, page_ids):
        kids = " ".join(f"{p} 0 R" for p in page_ids)
        pages_id = len(self.objs) + 1
        # Las páginas se crean antes que /Pages: su /Parent apunta a pages_id.
        self.add(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode())
        catalog = self.add(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())
        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objs, 1):
            offsets.append(len(out))
            out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
        xref = len(out)
        out += f"xref\n0 {len(self.objs) + 1}\n0000000000 65535 f \n".encode()
        for off in offsets:
            out += f"{off:010d} 00000 n \n".encode()
        out += (
            f"trailer\n<< /Size {len(self.objs) + 1} /Root {catalog} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode()
        Path(path).write_bytes(out)

    def page(self, content, resources, pages_id):
        c = self.stream("", content.encode("latin-1"))
        return self.add(
            f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources {resources} /Contents {c} 0 R >>".encode()
        )


def fondo_escaneo(rng, n):
    """Fondo de papel ligeramente coloreado con ruido de escáner, membrete y sello."""
    w, h = 1240, 1754  # A4 a 150 ppp
    img = Image.new("RGB", (w, h), (244, 240, 229))
    noise = Image.effect_noise((w, h), 6).convert("RGB")
    img = Image.blend(img, noise, 0.04)
    d = ImageDraw.Draw(img)
    d.rectangle([90, 70, 1150, 150], fill=(206, 219, 236))  # franja del membrete
    cx, cy = 980 - 40 * n, 1480
    d.ellipse([cx - 110, cy - 110, cx + 110, cy + 110], outline=(176, 42, 48), width=9)
    d.ellipse([cx - 80, cy - 80, cx + 80, cy + 80], outline=(176, 42, 48), width=4)
    for _ in range(30):  # manchas suaves del papel
        x, y, r = rng.randrange(w), rng.randrange(h), rng.randrange(20, 90)
        tono = rng.randrange(228, 240)
        d.ellipse([x - r, y - r, x + r, y + r], fill=(tono, tono - 3, tono - 12))
    return img.filter(ImageFilter.GaussianBlur(1.2))


def texto_escaneo(n):
    """Capa de texto en B/N a 300 ppp (A4 = 2480 x 3508)."""
    img = Image.new("1", (2480, 3508), 1)
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=40)
    y = 330
    for bloque in range(3):
        for linea in PARRAFOS:
            if y > 3250:
                break
            # La fuente por defecto de Pillow no trae tildes: se escriben sin ellas.
            plano = unicodedata.normalize("NFKD", linea).encode("ascii", "ignore").decode()
            d.text((250, y), plano, font=font, fill=0)
            y += 58
    d.text((1150, 3350), f"- {n + 1} -", font=font, fill=0)
    return img


def escaneo(path, paginas=3):
    rng = random.Random(SEED)
    pdf = Pdf()
    # Primero las imágenes; luego las páginas (2 objetos cada una) y detrás /Pages.
    imagenes = []
    for n in range(paginas):
        jpg = jpeg_bytes(fondo_escaneo(rng, n), 70, 150)
        bg = pdf.stream(
            "/Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB "
            "/BitsPerComponent 8 /Filter [/FlateDecode /DCTDecode]",
            zlib.compress(jpg, 9),
        )
        g4 = g4_bytes(texto_escaneo(n))
        fg = pdf.stream(
            "/Type /XObject /Subtype /Image /Width 2480 /Height 3508 /ImageMask true "
            "/BitsPerComponent 1 /Filter /CCITTFaxDecode "
            "/DecodeParms << /K -1 /Columns 2480 /Rows 3508 /BlackIs1 true >>",
            g4,
        )
        imagenes.append((bg, fg))
    pages_id = len(pdf.objs) + 2 * paginas + 1
    page_ids = []
    for bg, fg in imagenes:
        content = (
            f"q {PAGE_W} 0 0 {PAGE_H} 0 0 cm /Bg Do Q\n"
            f"q 0 g {PAGE_W} 0 0 {PAGE_H} 0 0 cm /Fg Do Q\n"
        )
        page_ids.append(pdf.page(content, f"<< /XObject << /Bg {bg} 0 R /Fg {fg} 0 R >> >>", pages_id))
    pdf.save(path, page_ids)


def pdf_str(s):
    b = s.encode("cp1252")
    return "(" + b.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)").decode("latin-1") + ")"


def foto(rng):
    """Foto sintética 1500 x 1000 (degradado + formas + ruido), para mostrar a 300 ppp."""
    w, h = 1500, 1000
    grad = Image.linear_gradient("L").resize((w, h))
    img = Image.merge("RGB", (grad, grad.rotate(90).resize((w, h)), Image.new("L", (w, h), 120)))
    d = ImageDraw.Draw(img)
    for _ in range(60):
        x, y, r = rng.randrange(w), rng.randrange(h), rng.randrange(15, 120)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(rng.randrange(256) for _ in range(3)))
    noise = Image.effect_noise((w, h), 40).convert("RGB")
    return Image.blend(img, noise, 0.15)


def texto(path, paginas=2):
    rng = random.Random(SEED + 1)
    pdf = Pdf()
    font = pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    jpg = jpeg_bytes(foto(rng), 90, 300)
    img = pdf.stream(
        "/Type /XObject /Subtype /Image /Width 1500 /Height 1000 /ColorSpace /DeviceRGB "
        "/BitsPerComponent 8 /Filter /DCTDecode",
        jpg,
    )
    # Datos ficticios: DNI con letra válida, dominio reservado, IBAN de ejemplo publicado.
    datos = [
        "Demandante: Persona Ficticia Uno, con DNI 12345678Z.",
        "Correo de contacto: persona.ficticia@example.com",
        "Teléfono: 600 123 456",
        "Cuenta para el pago: ES91 2100 0418 4502 0005 1332",
    ]
    pages_id = len(pdf.objs) + 2 * paginas + 1
    page_ids = []
    for n in range(paginas):
        lineas = [f"Documento sintético de prueba - página {n + 1}", ""] + datos + [""] + PARRAFOS[3:17]
        ops = ["BT /F1 11 Tf 14 TL 60 780 Td"] + [f"{pdf_str(l)} '" for l in lineas] + ["ET"]
        ops.append("q 360 0 0 240 117 90 cm /Im Do Q")  # 5 x 3,33 in -> 300 ppp
        page_ids.append(
            pdf.page("\n".join(ops), f"<< /Font << /F1 {font} 0 R >> /XObject << /Im {img} 0 R >> >>", pages_id)
        )
    pdf.save(path, page_ids)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Uso: python gen_pdfs.py <carpeta_salida>", file=sys.stderr)
        sys.exit(2)
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    escaneo(out / "escaneo.pdf")
    texto(out / "texto.pdf")
    for f in ("escaneo.pdf", "texto.pdf"):
        print(f"{f}: {(out / f).stat().st_size} bytes")
