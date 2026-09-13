import fitz
import sys
import json
import re
import uuid

fitz.TOOLS.mupdf_display_errors(False)

try:
    action = sys.argv[1]
    input_path = sys.argv[2]

    if action == "search":
        patterns_path = sys.argv[3]
        results_path = sys.argv[4]
        
        with open(patterns_path, 'r', encoding='utf-8') as f:
            patterns = json.load(f)
        
        doc = fitz.open(input_path)
        results = []
        
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text("text")
            
            p_width = page.rect.width
            p_height = page.rect.height
            
            raw_rects = []
            
            for category, pattern in patterns.items():
                try:
                    # Encontrar matches y obtener las posiciones reales en el texto
                    for match in re.finditer(pattern, text):
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
            json.dump({"results": results}, f)

    elif action == "apply":
        output_path = sys.argv[3]
        items_path = sys.argv[4]
        results_json_path = sys.argv[5] if len(sys.argv) > 5 else None
        
        with open(items_path, 'r', encoding='utf-8') as f:
            items = json.load(f)
            
        doc = fitz.open(input_path)
        
        failed_items = []
        applied_count = 0
        
        # Blindaje anticaídas con registro de fallos
        for item in items:
            try:
                page = doc[item["page"]]
                rect = fitz.Rect(item["rect"])
                # Forzamos opacidad absoluta en el relleno
                page.add_redact_annot(rect, fill=(0, 0, 0))
                applied_count += 1
            except Exception as e:
                failed_items.append({"id": item.get("id"), "error": str(e)})
            
        for page in doc:
            # CRÍTICO: images=fitz.PDF_REDACT_IMAGE_PIXELS garantiza la destrucción 
            # a nivel de píxel del escaneo subyacente. No se puede recuperar el dato tapado.
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
            
        # Limpieza forense agresiva (XMP, JS, Objetos huérfanos)
        try:
            doc.scrub()
        except AttributeError:
            pass
            
        doc.set_metadata({
            "creator": "PDFcadabra",
            "producer": "PDFcadabra LegalTech",
            "author": "",
            "title": "",
            "subject": "",
            "keywords": ""
        })
        
        doc.save(output_path, garbage=4, deflate=True, clean=True)
        
        if results_json_path:
            with open(results_json_path, 'w', encoding='utf-8') as f:
                json.dump({"success": True, "applied": applied_count, "failed": failed_items}, f)

except Exception as e:
    # Imprimir para que server.js lo capture en el stderr
    print(f"Error crítico en redact.py: {str(e)}", file=sys.stderr)
    sys.exit(1)
