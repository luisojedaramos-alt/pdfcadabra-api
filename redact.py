import fitz
import sys
import json
import re

input_path = sys.argv[1]
output_path = sys.argv[2]
patterns_json = sys.argv[3]

try:
    patterns = json.loads(patterns_json)
except:
    patterns = []

doc = fitz.open(input_path)

for page in doc:
    text = page.get_text("text")
    words_to_redact = set()
    
    # 1. Encontrar todas las palabras que coinciden con los patrones/regex
    for pattern in patterns:
        try:
            matches = re.finditer(pattern, text, re.IGNORECASE)
            for match in matches:
                words_to_redact.add(match.group())
        except:
            pass
            
    # 2. Localizar coordenadas exactas y aplicar la marca
    for word in words_to_redact:
        areas = page.search_for(word)
        for area in areas:
            page.add_redact_annot(area, fill=(0, 0, 0))
            
    # 3. APLICAR CENSURA (Destruye el texto inferior, irreversible)
    page.apply_redactions()

doc.save(output_path, garbage=3, deflate=True)
