# Dockerfile
# Multi-stage build — keeps the final image lean (no devDependencies, no source)
#
# Build: docker build -t obsidian-mcp-server .
# Run:   docker run -e VAULT_PATH=/vault -e TRANSPORT=http \
#               -v /path/to/vault:/vault:ro \
#               -p 3000:3000 obsidian-mcp-server

FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Only copy production deps
COPY package.json ./
RUN npm install --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp

# Vault is mounted here by Swarm/Docker
VOLUME ["/vault"]

ENV VAULT_PATH=/vault
ENV TRANSPORT=http
ENV PORT=3000
ENV VAULT_NAME="Obsidian Vault"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
