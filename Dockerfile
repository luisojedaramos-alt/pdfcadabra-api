FROM node:20-bookworm-slim

# Instalamos Ghostscript (compresión) y poppler-utils (motor de imágenes industriales)
RUN apt-get update && apt-get install -y --fix-missing ghostscript poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
