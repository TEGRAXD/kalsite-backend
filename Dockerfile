# ============================================================
# Stage 1: Build & Install
# ============================================================
FROM oven/bun:1.4 AS builder

WORKDIR /usr/src/kalsite-backend

# Copy package manifests
COPY package.json bun.lock ./

# Install dependencies
RUN --mount=type=cache,target=/root/.bun \
    bun install --frozen-lockfile

# Copy application source and Drizzle config
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM oven/bun:1.4

WORKDIR /usr/src/kalsite-backend

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=5000

# Copy runtime files and installed dependencies
COPY --from=builder /usr/src/kalsite-backend/package.json ./package.json
COPY --from=builder /usr/src/kalsite-backend/tsconfig.json ./tsconfig.json
COPY --from=builder /usr/src/kalsite-backend/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /usr/src/kalsite-backend/src ./src
COPY --from=builder /usr/src/kalsite-backend/node_modules ./node_modules

# Ensure local asset upload directories exist
RUN mkdir -p uploads/operators uploads/factions

EXPOSE 5000

CMD ["bun", "run", "start"]
