# Quantra AI Terminal — container image
FROM node:22-alpine
WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=5280
EXPOSE 5280

# data/ is for the file-store fallback; in the cloud set DATABASE_URL
# so persistence lives in Postgres instead of the container filesystem.
VOLUME ["/app/data"]

CMD ["node", "server.js"]
