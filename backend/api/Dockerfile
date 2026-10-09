# Build context: repository root (Railway: RAILWAY_DOCKERFILE_PATH=backend/api/Dockerfile).
# Debian from Amazon's public mirror plus a pinned Bun release: Railway's anonymous pulls
# of oven/bun from Docker Hub hit 429 rate limits.
FROM public.ecr.aws/docker/library/debian:bookworm-slim
ARG BUN_VERSION=1.4.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" \
 && unzip -q /tmp/bun.zip -d /tmp \
 && mv /tmp/bun-linux-x64-baseline/bun /usr/local/bin/bun \
 && rm -rf /tmp/bun.zip /tmp/bun-linux-x64-baseline /var/lib/apt/lists/* \
 && bun --version

WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first, for layer caching.
COPY package.json bun.lock ./
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY backend/api/package.json backend/api/
RUN bun install --frozen-lockfile --production --filter=@repo/api

COPY packages/db packages/db
COPY packages/core packages/core
COPY backend/api backend/api

EXPOSE 4000
# Single instance: apply migrations, then start.
CMD ["sh", "-c", "bun packages/db/src/migrate.ts && exec bun backend/api/src/index.ts"]
