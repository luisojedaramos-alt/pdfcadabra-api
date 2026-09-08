import fitz
import sys
import json
import re

action = sys.argv[1]
input_path = sys.argv[2]

if action == "search":
    # Modo Escaneo: Busca y extrae el contexto
    patterns = json.loads(sys.argv[3]) # Diccionario { "Categoria": "Regex" }
    doc = fitz.open(input_path)
    results = []
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text")
        
        for category, pattern in patterns.items():
            try:
                for match in re.finditer(pattern, text):
                    val = match.group().strip()
                    if not val: continue
                    
                    # Extraer contexto (+/- 25 caracteres alrededor)
                    start = max(0, match.start() - 25)
                    end = min(len(text), match.end() + 25)
                    context = text[start:end].replace('\n', ' ').strip()
                    
                    # Localizar coordenadas
                    areas = page.search_for(val)
                    for area in areas:
                        results.append({
                            "id": f"p{page_num}_{area.x0}_{area.y0}",
                            "page": page_num, # Índice interno (0 = pág 1)
                            "text": val,
                            "context": f"...{context}...",
                            "category": category,
                            "rect": [area.x0, area.y0, area.x1, area.y1]
                        })
            except:
                pass
                
    print(json.dumps(results))

elif action == "apply":
    # Modo Ejecución: Destruye el texto en las coordenadas exactas confirmadas
    output_path = sys.argv[3]
    items = json.loads(sys.argv[4]) # Lista de {page, rect}
    doc = fitz.open(input_path)
    
    for item in items:
        page = doc[item["page"]]
        rect = fitz.Rect(item["rect"])
        page.add_redact_annot(rect, fill=(0, 0, 0))
        
    for page in doc:
        page.apply_redactions()
        
    doc.save(output_path, garbage=3, deflate=True)
