FROM node:20-bookworm-slim

# Instalamos Ghostscript en un sistema Linux más moderno
RUN apt-get update && apt-get install -y --fix-missing ghostscript && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
