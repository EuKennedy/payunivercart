# syntax=docker/dockerfile:1.7

# =========================================================================
# @payunivercart/api — runtime image.
#
# We intentionally run TypeScript source via `tsx` in production:
#   - The monorepo publishes workspace packages as `.ts` source (no dist),
#     which is the right tradeoff for internal-only packages (single source
#     of truth, no stale dist, no dual-publish complexity).
#   - `tsx` resolves `.ts` at runtime with negligible (~150ms) cold-start
#     cost. The api process is long-lived so this is paid once per boot.
#   - tsc still runs in CI (`pnpm typecheck`) so the type guarantees are
#     preserved; the runtime simply doesn't need a pre-compiled `dist/`.
#
# When the apps/workers/api start showing measurable startup pressure (e.g.,
# cold start under autoscaling), revisit by adding a `build` step that
# compiles workspace packages to `dist/` and updating their `main` fields.
# =========================================================================

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.3

# -------------------------------------------------------------------------
# Builder — install full workspace dep graph (incl. devDeps so type-checks
# in CI can run identically against the same node_modules layout).
# -------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

ARG PNPM_VERSION

# Force `development` so pnpm keeps devDependencies even if the orchestrator
# leaks NODE_ENV=production as a build-time env. Runtime stage overrides.
ENV NODE_ENV=development \
    PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}" \
    COREPACK_DEFAULT_TO_LATEST=0

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# `psql` is needed by the `migrate` compose service which runs against
# this image's `builder` target. The runtime stage doesn't ship it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# Workspace + lockfile + every package manifest first, so `pnpm install`
# resolves the full graph before any source is copied (max cache hit rate).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY tsconfig.base.json ./

COPY apps/api/package.json apps/api/
COPY packages/auth/package.json packages/auth/
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/audit/package.json packages/audit/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY packages/waha/package.json packages/waha/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Source last so cache invalidates only on actual code changes.
COPY apps/api apps/api
COPY packages packages

# -------------------------------------------------------------------------
# Runtime — slim image with the full /repo tree (source + node_modules
# symlinks) so pnpm's workspace symlinks resolve at runtime.
# -------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

RUN groupadd --system --gid 10001 api \
    && useradd  --system --uid 10001 --gid api --no-create-home api

WORKDIR /repo

COPY --chown=api:api --from=builder /repo /repo

USER api

EXPOSE 4000

# `tsx` is in the api package's runtime dependencies. It transparently
# resolves the workspace `.ts` sources at runtime.
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
