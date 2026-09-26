# Node 24 LTS (fin de soporte 2028-04-30) sobre Debian 13 trixie
FROM node:24-trixie-slim

# Instalar Python y dependencias gráficas
RUN apt-get update && apt-get install -y --fix-missing ghostscript poppler-utils python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Crear entorno virtual de Python e instalar PyMuPDF
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install PyMuPDF==1.28.2

COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
