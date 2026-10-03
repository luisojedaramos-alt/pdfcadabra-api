"""Comprobaciones de PDF que comparten lossless_images.py y redact.py.

- needs_password(doc): el PDF necesita contraseña de apertura. Los de solo contraseña de
  propietario (se abren sin clave, con permisos restringidos, como muchos de sedes judiciales)
  se abren con la contraseña vacía y NO cuentan: se siguen procesando.
"""
EXIT_ENCRYPTED = 3  # server.js responde 422 PDF_ENCRYPTED


def needs_password(doc):
    """True si el PDF solo se abre con una contraseña de apertura que no tenemos."""
    return bool(doc.needs_pass) and not doc.authenticate("")
