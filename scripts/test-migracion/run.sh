#!/bin/bash
# Prueba de la migración de la imagen (node:24-trixie-slim) contra producción, solo con curl.
#
#   bash scripts/test-migracion/run.sh <url_servicio_temporal> [url_produccion] [repeticiones=3]
#
# Con los mismos PDF sintéticos (gen_pdfs.py, sin datos reales) en los dos servicios:
#   1. Comprimir, niveles extreme / recommended / low, sobre un escaneo de juzgado
#      (fondo JPEG con Flate + texto CCITT) y un PDF de texto con foto. Compara el
#      tamaño de salida (avisa si difiere más de un 5 %) y el tiempo (mediana).
#   2. Anonimizar completo: search + apply, y un search del resultado, que debe
#      salir vacío (los datos ya no están en el PDF).
#   3. Solo en el temporal: peticiones que acaban mal (400 y cliente que corta a
#      mitad), para comprobar después en el log que no quedan temporales.
# Sin cabecera Origin: el CORS solo acepta pdfcadabra.com, pero deja pasar curl.
set -u

TEMP=${1:?uso: run.sh <url_servicio_temporal> [url_produccion] [repeticiones]}
PROD=${2:-https://pdfcadabra-api.onrender.com}
REPS=${3:-3}
TEMP=${TEMP%/}; PROD=${PROD%/}
DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pdfcadabra-migracion.XXXXXX")"
# Git Bash en Windows: curl y python nativos no entienden rutas /tmp/... de MSYS.
command -v cygpath > /dev/null && WORK=$(cygpath -m "$WORK")
REPORT="$WORK/informe.txt"
PATTERNS='{"dni":"\\b\\d{8}[A-Z]\\b","email":"[\\w.+-]+@[\\w-]+\\.[\\w.]+","telefono":"\\b[6-9]\\d{2} ?\\d{3} ?\\d{3}\\b","iban":"\\bES\\d{2}(?: ?\\d{4}){5}\\b"}'

log() { echo "$*" | tee -a "$REPORT"; }

# --- Python con Pillow para generar los PDF (venv propio si el del sistema no lo tiene)
PY=$(command -v python3 || command -v python) || { echo "Falta Python 3"; exit 1; }
if ! "$PY" -c "import PIL" 2>/dev/null; then
  VENV="${TMPDIR:-/tmp}/pdfcadabra-test-venv"
  [ -d "$VENV" ] || "$PY" -m venv "$VENV" || exit 1
  PY=$(ls "$VENV"/bin/python "$VENV"/Scripts/python.exe 2>/dev/null | head -1)
  "$PY" -c "import PIL" 2>/dev/null || "$PY" -m pip install -q Pillow==11.3.0 || exit 1
fi
"$PY" "$DIR/gen_pdfs.py" "$WORK/in" > /dev/null || exit 1

log "Prueba de migración  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "  producción: $PROD"
log "  temporal:   $TEMP"
log "  repeticiones por medida: $REPS   (resultados en $WORK)"

# --- Despertar los servicios (el plan gratuito se duerme a los 15 min sin tráfico)
for base in "$PROD" "$TEMP"; do
  for i in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/v1/queue/status/test")
    [ "$code" = 200 ] && break
    sleep 5
  done
  [ "$code" = 200 ] || { log "ERROR: $base no responde (último código $code)"; exit 1; }
done

# valid_pdf <fichero>: empieza por %PDF- y termina en %%EOF
valid_pdf() { head -c 5 "$1" | grep -q '%PDF-' && tail -c 64 "$1" | grep -q '%%EOF'; }

# compress <base> <pdf> <nivel> <salida>: imprime "código tamaño ttfb total estado"
compress() {
  local hdr="$4.h" m
  m=$(curl -s -o "$4" -D "$hdr" --max-time 600 -F "file=@$2;type=application/pdf" -F "level=$3" \
    -w '%{http_code} %{size_download} %{time_starttransfer} %{time_total}' "$1/v1/compress")
  echo "$m $(grep -i '^x-compress-status' "$hdr" | awk '{print $2}' | tr -d '\r')"
}

median() { sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'; }
pct() { awk -v a="$1" -v b="$2" 'BEGIN {if (a > 0) printf "%+.1f", (b - a) * 100 / a; else print "nan"}'; }
ALERTS=0

# Calentamiento (primer gs/python tras arrancar), no cuenta.
compress "$PROD" "$WORK/in/texto.pdf" low "$WORK/warm-p.pdf" > /dev/null
compress "$TEMP" "$WORK/in/texto.pdf" low "$WORK/warm-t.pdf" > /dev/null

log ""
log "== 1. Comprimir (tamaño en bytes; tiempo = mediana de $REPS, total de la petición)"
printf '%-12s %-12s %11s %11s %8s %8s %8s %8s  %s\n' PDF nivel "tam.prod" "tam.temp" "dif%" "t.prod" "t.temp" "ratio" "estado" | tee -a "$REPORT"
for pdf in escaneo texto; do
  in="$WORK/in/$pdf.pdf"
  for level in extreme recommended low; do
    : > "$WORK/tp"; : > "$WORK/tt"; sp=""; st=""; ep=""; et=""; bad=""; var=""
    for r in $(seq 1 "$REPS"); do
      # Alternando el orden para no favorecer a ninguno de los dos.
      for side in p t; do
        base=$PROD; [ $side = t ] && base=$TEMP
        out="$WORK/out/$side-$pdf-$level-$r.pdf"; mkdir -p "$WORK/out"
        read -r code size ttfb total status <<< "$(compress "$base" "$in" "$level" "$out")"
        if [ "$code" != 200 ] || ! valid_pdf "$out"; then bad="$bad $side:$code"; continue; fi
        echo "$total" >> "$WORK/t$side"
        if [ $side = p ]; then sp=${sp:-$size}; ep=$status; else st=${st:-$size}; et=$status; fi
        # Mismo PDF y mismo lado: el tamaño debería repetirse exactamente.
        { [ $side = p ] && [ "$size" != "$sp" ]; } || { [ $side = t ] && [ "$size" != "$st" ]; } \
          && var="  (tamaño variable entre repeticiones en $side)"
      done
    done
    if [ -n "$bad" ] || [ -z "$sp" ] || [ -z "$st" ]; then
      log "$(printf '%-12s %-12s ERROR:%s' "$pdf" "$level" "$bad")"; ALERTS=$((ALERTS + 1)); continue
    fi
    d=$(pct "$sp" "$st"); mp=$(median < "$WORK/tp"); mt=$(median < "$WORK/tt")
    ratio=$(awk -v a="$mp" -v b="$mt" 'BEGIN {printf "%.2f", b / a}')
    flag=""
    awk -v d="$d" 'BEGIN {exit !(d > 5 || d < -5)}' && { flag="  <-- TAMAÑO >5 %"; ALERTS=$((ALERTS + 1)); }
    [ "$ep" != "$et" ] && { flag="$flag  <-- ESTADO DISTINTO"; ALERTS=$((ALERTS + 1)); }
    awk -v r="$ratio" 'BEGIN {exit !(r > 1.2)}' && flag="$flag  <-- MÁS LENTO"
    printf '%-12s %-12s %11s %11s %8s %7.2fs %7.2fs %8s  %s/%s%s%s\n' "$pdf" "$level" "$sp" "$st" "$d" "$mp" "$mt" "$ratio" "$ep" "$et" "$flag" "$var" | tee -a "$REPORT"
  done
done
log "  (tamaños de entrada: escaneo $(wc -c < "$WORK/in/escaneo.pdf") B, texto $(wc -c < "$WORK/in/texto.pdf") B)"

# --- 2. Anonimizar: search + apply + search del resultado
json_count() { "$PY" -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["results"]))' "$1" 2>/dev/null || echo "?"; }
json_items() { "$PY" -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["results"]))' "$1"; }

log ""
log "== 2. Anonimizar (texto.pdf)"
printf '%-8s %8s %9s %9s %10s %9s %13s\n' lado hallazgos t.search t.apply tam.salida avisos "search final" | tee -a "$REPORT"
for side in p t; do
  base=$PROD; [ $side = t ] && base=$TEMP
  s="$WORK/search-$side.json"; o="$WORK/censurado-$side.pdf"
  read -r c1 t1 <<< "$(curl -s -o "$s" --max-time 600 -F "file=@$WORK/in/texto.pdf;type=application/pdf" \
    --form-string "patterns=$PATTERNS" -w '%{http_code} %{time_total}' "$base/v1/redact/search")"
  n=$(json_count "$s")
  read -r c2 t2 <<< "$(curl -s -o "$o" -D "$o.h" --max-time 600 -F "file=@$WORK/in/texto.pdf;type=application/pdf" \
    --form-string "items=$(json_items "$s")" -w '%{http_code} %{time_total}' "$base/v1/redact/apply")"
  warn=$(grep -ci '^x-redact-warnings' "$o.h")
  read -r c3 _ <<< "$(curl -s -o "$s.final" --max-time 600 -F "file=@$o;type=application/pdf" \
    --form-string "patterns=$PATTERNS" -w '%{http_code} %{time_total}' "$base/v1/redact/search")"
  n3=$(json_count "$s.final")
  ok=OK
  { [ "$c1" = 200 ] && [ "$c2" = 200 ] && [ "$c3" = 200 ] && valid_pdf "$o" && [ "$n" != "?" ] && [ "$n" -gt 0 ] && [ "$n3" = 0 ] && [ "$warn" = 0 ]; } \
    || { ok="FALLO (códigos $c1/$c2/$c3)"; ALERTS=$((ALERTS + 1)); }
  printf '%-8s %8s %8.2fs %8.2fs %10s %9s %13s  %s\n' "$([ $side = p ] && echo prod || echo temp)" "$n" "$t1" "$t2" "$(wc -c < "$o" 2>/dev/null || echo 0)" "$warn" "$n3" "$ok" | tee -a "$REPORT"
  eval "n_$side=$n; o_$side=$(wc -c < "$o" 2>/dev/null || echo 0)"
done
[ "$n_p" != "$n_t" ] && { log "  <-- NÚMERO DE HALLAZGOS DISTINTO"; ALERTS=$((ALERTS + 1)); }
d=$(pct "$o_p" "$o_t"); log "  salida censurada: diferencia de tamaño $d %"
[ "$d" != nan ] && awk -v d="$d" 'BEGIN {exit !(d > 5 || d < -5)}' && { log "  <-- TAMAÑO >5 %"; ALERTS=$((ALERTS + 1)); }

# --- 3. Rutas que acaban mal, solo en el temporal (sus temporales también deben borrarse)
log ""
log "== 3. Errores en el temporal (para revisar después los temporales en el log)"
c=$(curl -s -o /dev/null -w '%{http_code}' -F "file=@$WORK/in/texto.pdf;type=application/pdf" "$TEMP/v1/redact/search")
log "  search sin patrones:          HTTP $c (esperado 400)"
c=$(curl -s -o /dev/null -w '%{http_code}' -F "file=@$WORK/in/texto.pdf;type=application/pdf" "$TEMP/v1/redact/apply")
log "  apply sin hallazgos:          HTTP $c (esperado 400)"
curl -s -o /dev/null --max-time 2 -F "file=@$WORK/in/escaneo.pdf;type=application/pdf" -F level=extreme "$TEMP/v1/compress"
log "  compress cortado a los 2 s:   curl salió con $? (28 = cortado; 0 = acabó antes y no se probó el corte)"
log "  Hora de fin: $(date -u +%H:%M:%S) UTC. Pasados ~60 s, en Logs del servicio temporal la"
log "  última línea [tmpcheck] debe decir 0 archivos."

log ""
if [ "$ALERTS" = 0 ]; then log "RESULTADO: sin diferencias de tamaño >5 % ni fallos."; else log "RESULTADO: $ALERTS aviso(s), revisar arriba."; fi
log "Informe: $REPORT"
