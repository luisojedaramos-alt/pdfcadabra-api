"""Vuelve a envolver en Flate las imágenes JPEG de un PDF, sin pérdida.

Ghostscript (pdfwrite) copia los JPEG tal cual pero les quita la capa Flate
exterior (Filter [/FlateDecode /DCTDecode]). En los escaneos de juzgado esa capa
reduce mucho los fondos JPEG, así que sin ella el PDF "comprimido" pesa más que el
original. Este paso la restaura: comprime con zlib el JPEG ya codificado (los
píxeles no cambian) y solo lo sustituye si así ocupa menos. No toca nada más del
documento.

Uso: python3 jpeg_flate.py <entrada.pdf> <salida.pdf>
"""
import sys
import zlib

import pymupdf


def main(input_path, output_path):
    doc = pymupdf.open(input_path)
    for xref in range(1, doc.xref_length()):
        if doc.xref_get_key(xref, "Subtype") != ("name", "/Image"):
            continue
        filter_type, filter_value = doc.xref_get_key(xref, "Filter")
        if not (
            (filter_type == "name" and filter_value == "/DCTDecode")
            or (filter_type == "array" and filter_value.replace(" ", "") == "[/DCTDecode]")
        ):
            continue

        jpeg = doc.xref_stream_raw(xref)
        wrapped = zlib.compress(jpeg, 9)
        if len(wrapped) >= len(jpeg):
            continue

        # Los DecodeParms van por filtro: el nuevo /FlateDecode no lleva (null).
        parms_type, parms_value = doc.xref_get_key(xref, "DecodeParms")
        doc.update_stream(xref, wrapped, compress=False)
        doc.xref_set_key(xref, "Filter", "[/FlateDecode /DCTDecode]")
        if parms_type == "dict":
            doc.xref_set_key(xref, "DecodeParms", f"[null {parms_value}]")
        elif parms_type == "array":
            doc.xref_set_key(xref, "DecodeParms", "[null " + parms_value.strip()[1:])

    doc.save(output_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Uso: python3 jpeg_flate.py <entrada.pdf> <salida.pdf>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
