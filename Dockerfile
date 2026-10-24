# syntax=docker/dockerfile:1
#
# Two images from one file:
#   --target runner  the web app: Next.js standalone output only, no dev dependencies (default)
#   --target tools   full source + node_modules: background worker, migrations and CLI scripts
#
# Debian slim, not Alpine: onnxruntime-node (local embeddings) ships glibc binaries only.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# --- Dependencies (cached until package*.json changes) ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# --- Production build. No secrets: the build must succeed with no env vars set. ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Worker, migrations and scripts. Runs TypeScript directly through tsx. ---
FROM base AS tools
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p .cache && chown node:node .cache
USER node
CMD ["node_modules/.bin/tsx", "--conditions=react-server", "scripts/worker.mts"]

# --- Web app ---
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# server.js serves public/ and .next/static itself when they sit next to it.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# Embedding model cache (~130 MB, downloaded on first use). Mount a volume here to keep it.
RUN mkdir -p .cache && chown node:node .cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
