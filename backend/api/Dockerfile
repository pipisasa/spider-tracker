# Build context: repository root (Railway: RAILWAY_DOCKERFILE_PATH=backend/api/Dockerfile).
FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first, for layer caching.
COPY package.json bun.lock ./
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY backend/api/package.json backend/api/
RUN bun install --frozen-lockfile --production --filter=@repo/api

COPY packages/db packages/db
COPY packages/core packages/core
COPY backend/api backend/api

EXPOSE 4000
# Single instance: apply migrations, then start.
CMD ["sh", "-c", "bun packages/db/src/migrate.ts && exec bun backend/api/src/index.ts"]
