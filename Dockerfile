# ============================================================================
# Stage 1: Dependency Builder
# ============================================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies required for native addons (bcrypt, bufferutil, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first to leverage Docker layer caching
COPY package.json ./

# Install production dependencies (including Linux-specific @resvg/resvg-js binary)
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# ============================================================================
# Stage 2: Production Runtime (Lightweight & Optimized for Render 24/7)
# ============================================================================
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Install runtime essentials:
# - tini: Proper PID 1 init for graceful SIGTERM handling on Render deploys
# - fontconfig & fonts-dejavu-core: Required by @resvg/resvg-js to render chart text on Linux
# - ca-certificates: TLS certificates for Solana RPC, PumpPortal WSS, and Telegram API
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    fontconfig \
    fonts-dejavu-core \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Set production environment and cap V8 heap to prevent OOM on low-cost Render instances
ENV NODE_ENV=production
ENV PORT=2059
ENV NODE_OPTIONS="--max-old-space-size=384"

# Copy compiled production node_modules from builder stage
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application source code
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# Run as non-root user for container security
USER node

EXPOSE 2059

# Built-in container health check hitting Express /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "const port = process.env.PORT || 2059; fetch('http://127.0.0.1:' + port + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
