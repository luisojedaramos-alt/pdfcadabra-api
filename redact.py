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
    
    for pattern in patterns:
        try:
            # ELIMINADO el re.IGNORECASE global. La inteligencia ahora va en el patrón.
            matches = re.finditer(pattern, text)
            for match in matches:
                words_to_redact.add(match.group().strip())
        except:
            pass
            
    for word in words_to_redact:
        if not word: continue
        areas = page.search_for(word)
        for area in areas:
            page.add_redact_annot(area, fill=(0, 0, 0))
            
    page.apply_redactions()

doc.save(output_path, garbage=3, deflate=True)
