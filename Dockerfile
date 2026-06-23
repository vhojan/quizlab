FROM node:20-alpine
WORKDIR /app

# Install dependencies
COPY backend/package.json ./
RUN npm install --omit=dev

# Copy app files
COPY backend/server.js ./
COPY frontend/public ./frontend/public

# Data directory for SQLite (mount a PVC here)
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "server.js"]
