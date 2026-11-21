# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build Frontend & Install Production Dependencies
# ==============================================================================
FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ==============================================================================
# Stage 2: Production Cloud Run Runtime
# ==============================================================================
FROM node:24-bookworm-slim AS runner

WORKDIR /app

# Install Arabic & Latin fonts required by PdfGenerator (DejaVu + Noto Arabic) and CA certs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-dejavu-core \
    fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    TELEGRAM_MODE=webhook \
    WEBHOOK_EXECUTION_MODE=async \
    LOG_FORMAT=json

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built SPA frontend, server entry point, backend source modules, and assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/firebase-applet-config.json ./firebase-applet-config.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/firestore.rules.test.ts ./firestore.rules.test.ts
COPY --from=builder /app/firestore.rules ./firestore.rules

# Ensure temp directory for generated files is writable by non-root user
RUN mkdir -p /tmp/mr-hany-files && chown -R node:node /app /tmp/mr-hany-files

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
