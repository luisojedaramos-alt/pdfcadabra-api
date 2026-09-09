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
            
            # 1. Almacenar resultados brutos
            raw_rects = []
            
            for category, pattern in patterns.items():
                try:
                    # Extraer solo los textos únicos que hacen match para no multiplicar las búsquedas
                    matched_strings = set()
                    for match in re.finditer(pattern, text):
                        val = match.group().strip()
                        if val:
                            matched_strings.add(val)
                    
                    for val in matched_strings:
                        # Extraer contexto
                        idx = text.find(val)
                        context = ""
                        if idx != -1:
                            start = max(0, idx - 25)
                            end = min(len(text), idx + len(val) + 25)
                            context = text[start:end].replace('\n', ' ').strip()
                        
                        areas = page.search_for(val)
                        for area in areas:
                            raw_rects.append({
                                "id": str(uuid.uuid4()), # ID robusto y único
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
            
            # 2. Deduplicación inteligente de coordenadas (Resuelve el bug de los duplicados)
            seen_coordinates = set()
            for r in raw_rects:
                # Creamos una huella basada en la posición redondeada para evitar duplicados milimétricos
                coord_hash = f"{r['page']}_{round(r['rect'][0], 1)}_{round(r['rect'][1], 1)}"
                if coord_hash not in seen_coordinates:
                    seen_coordinates.add(coord_hash)
                    results.append(r)
                    
        with open(results_path, 'w', encoding='utf-8') as f:
            json.dump(results, f)

    elif action == "apply":
        output_path = sys.argv[3]
        items_path = sys.argv[4]
        
        with open(items_path, 'r', encoding='utf-8') as f:
            items = json.load(f)
            
        doc = fitz.open(input_path)
        
        # Blindaje anticaídas: Si una caja es inválida, se ignora en lugar de bloquear el proceso
        for item in items:
            try:
                page = doc[item["page"]]
                rect = fitz.Rect(item["rect"])
                page.add_redact_annot(rect, fill=(0, 0, 0))
            except Exception:
                continue
            
        for page in doc:
            page.apply_redactions()
            
        # Limpieza forense agresiva (XMP, Adjuntos, JS)
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

except Exception as e:
    sys.exit(1)
