#!/bin/bash
# Mide /v1/compress con curl. La API exige un Origin permitido en los POST: se envía
# ORIGIN (por defecto https://pdfcadabra.com). Tiempos = total del curl, con subida y bajada.
#
#   bash deploy/bench.sh <url_base> <carpeta_con_pdfs> serie
#       expediente-155p.pdf y escaneo-color-23p.pdf, en recommended, extreme y low (6, en serie)
#   bash deploy/bench.sh <url_base> <carpeta_con_pdfs> simultaneas [n=3] [nivel=recommended]
#       n peticiones a la vez del expediente
#
# Salida: una línea CSV por petición
#   modo,archivo,nivel,http,x-compress-status,x-compress-level,bytes_salida,t_total_s
# Los PDF de salida quedan en <carpeta>/out-<host>/ (borrarlos al terminar).
set -u
ORIGIN=${ORIGIN:-https://pdfcadabra.com}
curl() { command curl -H "Origin: $ORIGIN" "$@"; }

BASE=${1:?uso: bench.sh <url_base> <carpeta> serie|simultaneas [n] [nivel]}
DIR=${2:?falta la carpeta de PDFs}
MODE=${3:?falta el modo: serie o simultaneas}
BASE=${BASE%/}
HOST=$(echo "$BASE" | sed -E 's#https?://##; s#/.*##')
OUT="$DIR/out-$HOST"
mkdir -p "$OUT"

one() { # one <modo> <archivo> <nivel> <sufijo>
  local name=${2%.pdf} hdr="$OUT/${2%.pdf}-$3-$4.h" out="$OUT/${2%.pdf}-$3-$4.pdf" m
  m=$(curl -s -o "$out" -D "$hdr" --max-time 600 -H "X-Request-Id: $(cat /proc/sys/kernel/random/uuid 2>/dev/null || python -c 'import uuid;print(uuid.uuid4())')" \
    -F "file=@$DIR/$2;type=application/pdf" -F "level=$3" \
    -w '%{http_code},%{size_download},%{time_total}' "$BASE/v1/compress")
  local code=${m%%,*} rest=${m#*,}
  local st lv
  st=$(grep -i '^x-compress-status' "$hdr" | awk '{print $2}' | tr -d '\r')
  lv=$(grep -i '^x-compress-level' "$hdr" | awk '{print $2}' | tr -d '\r')
  echo "$1,$2,$3,$code,${st:--},${lv:--},${rest%%,*},${rest#*,}"
}

echo "modo,archivo,nivel,http,status,level,bytes,t_total_s"
case "$MODE" in
  serie)
    for f in expediente-155p.pdf escaneo-color-23p.pdf; do
      for l in recommended extreme low; do one serie "$f" "$l" s; done
    done ;;
  simultaneas)
    N=${4:-3}; L=${5:-recommended}
    for i in $(seq 1 "$N"); do one "simultanea-$i" expediente-155p.pdf "$L" "p$i" & done
    wait ;;
  *) echo "modo desconocido: $MODE"; exit 1 ;;
esac
