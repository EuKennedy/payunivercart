# syntax=docker/dockerfile:1.7

# =========================================================================
# Multi-stage build for @payunivercart/api.
# Stage 1: install ALL workspace deps + build the api bundle.
# Stage 2: minimal runtime image (Node 22 slim) with only the built artifact
#          and production deps.
# =========================================================================

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.3

# -------------------------------------------------------------------------
# Builder
# -------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Re-import the global ARG into this stage's scope.
ARG PNPM_VERSION

# Force `development` during build so `pnpm install` keeps devDependencies
# (typescript, tsx, etc.) even when the orchestrator (Coolify) leaks
# `NODE_ENV=production` as a build-time env var. The runtime stage sets
# `NODE_ENV=production` separately.
ENV NODE_ENV=development \
    PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}" \
    COREPACK_DEFAULT_TO_LATEST=0

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

# Copy lockfile + workspace manifest first to maximize the docker cache.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY tsconfig.base.json ./

# Copy every package manifest (cheap) so `pnpm install --frozen-lockfile`
# resolves the full graph before we copy source.
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/audit/package.json packages/audit/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY packages/waha/package.json packages/waha/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now copy the actual source code and build.
COPY apps/api apps/api
COPY packages packages

RUN pnpm --filter @payunivercart/api build

# Prune to production-only dependencies for the runtime stage.
RUN pnpm --filter @payunivercart/api... \
    --prod \
    deploy /repo/runtime

# -------------------------------------------------------------------------
# Runtime
# -------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

# Add a non-root user. Anything that needs to write goes through a mount.
RUN groupadd --system --gid 10001 api \
    && useradd  --system --uid 10001 --gid api --no-create-home api

WORKDIR /app

# Copy only the deployed artifact (built JS + minimal node_modules).
COPY --chown=api:api --from=builder /repo/runtime/dist ./dist
COPY --chown=api:api --from=builder /repo/runtime/node_modules ./node_modules
COPY --chown=api:api --from=builder /repo/runtime/package.json ./package.json

USER api

EXPOSE 4000

# `--enable-source-maps` is set via NODE_OPTIONS so any imported module
# (e.g. tsx during local debugging) inherits it.
CMD ["node", "dist/server.js"]
