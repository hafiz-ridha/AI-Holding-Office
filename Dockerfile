# syntax=docker/dockerfile:1
# AI Virtual Holding — single lightweight container (Node.js 24 LTS on Alpine, non-root).

# ---- stage 1: production dependencies only (pure JS; no native build tools needed) ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- stage 2: runtime ----
FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data
WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app/data
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
# Heap capped at 96 MB; node handles SIGTERM for a graceful shutdown (compose adds an init process).
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=96", "src/server.js"]
