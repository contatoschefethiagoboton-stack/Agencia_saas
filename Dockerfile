# Imagem única: API (Express) + painel React já compilado, servido pela própria API.
# ---------- 1) build do frontend ----------
FROM node:22-alpine AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2) build do backend ----------
FROM node:22-alpine AS api
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ---------- 3) imagem final ----------
FROM node:22-alpine
RUN apk add --no-cache redis          # usado só quando REDIS_URL não está definida
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=api /app/backend/node_modules ./node_modules
COPY --from=api /app/backend/dist ./dist
COPY --from=api /app/backend/package.json ./package.json
COPY --from=web /app/frontend/dist ./public
COPY db ./db
COPY docker-entrypoint.sh ./
USER node
EXPOSE 3000
# O entrypoint aplica as migrações pendentes e depois roda o comando.
# Para o worker (Background Worker no Render), troque o comando para: node dist/workers.js
ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
