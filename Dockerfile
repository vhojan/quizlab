FROM node:20-alpine
WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/server.js ./
COPY frontend/ ./frontend/

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "server.js"]
