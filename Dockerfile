# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# Enable pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config files first (better layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./

# Copy all package.json files for workspace resolution
COPY lib/db/package.json ./lib/db/package.json
COPY lib/api-zod/package.json ./lib/api-zod/package.json
COPY lib/api-client-react/package.json ./lib/api-client-react/package.json
COPY lib/api-spec/package.json ./lib/api-spec/package.json
COPY scripts/package.json ./scripts/package.json
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY artifacts/discharge-buddy/package.json ./artifacts/discharge-buddy/package.json
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/package.json

# Install dependencies using the lockfile (reproducible builds)
RUN pnpm install --frozen-lockfile

# Copy full source
COPY . .

# Build the api-server (esbuild bundles everything into dist/)
RUN pnpm --filter @workspace/api-server run build

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-slim AS runner

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY lib/db/package.json ./lib/db/package.json
COPY lib/api-zod/package.json ./lib/api-zod/package.json
COPY lib/api-client-react/package.json ./lib/api-client-react/package.json
COPY lib/api-spec/package.json ./lib/api-spec/package.json
COPY scripts/package.json ./scripts/package.json
COPY artifacts/discharge-buddy/package.json ./artifacts/discharge-buddy/package.json
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/package.json

# Install ONLY production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy the built dist and migrations
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/api-server/run_migration.mjs ./artifacts/api-server/run_migration.mjs
COPY --from=builder /app/lib/db/drizzle ./lib/db/drizzle
COPY --from=builder /app/.env ./.env

# GCP Cloud Run injects $PORT at runtime (default 8080)
EXPOSE 8080

# Run migrations and start server
CMD ["sh", "-c", "node ./artifacts/api-server/run_migration.mjs && node --enable-source-maps ./artifacts/api-server/dist/index.mjs"]
