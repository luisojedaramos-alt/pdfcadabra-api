import fitz
import sys
import json
import re

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
            
            # Extraer dimensiones exactas del folio
            p_width = page.rect.width
            p_height = page.rect.height
            
            for category, pattern in patterns.items():
                try:
                    for match in re.finditer(pattern, text):
                        val = match.group().strip()
                        if not val: continue
                        
                        start = max(0, match.start() - 25)
                        end = min(len(text), match.end() + 25)
                        context = text[start:end].replace('\n', ' ').strip()
                        
                        areas = page.search_for(val)
                        for area in areas:
                            results.append({
                                "id": f"p{page_num}_{area.x0}_{area.y0}_{category}",
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
                    
        with open(results_path, 'w', encoding='utf-8') as f:
            json.dump(results, f)

    elif action == "apply":
        output_path = sys.argv[3]
        items_path = sys.argv[4]
        
        with open(items_path, 'r', encoding='utf-8') as f:
            items = json.load(f)
            
        doc = fitz.open(input_path)
        
        for item in items:
            page = doc[item["page"]]
            rect = fitz.Rect(item["rect"])
            page.add_redact_annot(rect, fill=(0, 0, 0))
            
        for page in doc:
            page.apply_redactions()
            
        doc.save(output_path, garbage=3, deflate=True)

except Exception as e:
    sys.exit(1)
