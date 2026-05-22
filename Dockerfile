# syntax=docker/dockerfile:1.7
#
# =============================================================================
# payunivercart — single multi-target Dockerfile for the entire monorepo.
#
# Why one Dockerfile and not five
# --------------------------------
# Previously each app shipped its own Dockerfile that did `pnpm install`
# from scratch. When Coolify's `docker compose build` fan-out hit the VPS
# all five `pnpm install` steps ran in parallel — 5× the package downloads,
# 5× the disk writes, 5× the RAM. The build container then OOMed mid-way
# through one of the Next builds and Coolify aborted the whole deploy.
#
# This file flattens the dep graph into ONE shared `deps` stage. Every
# downstream target — api, dashboard, checkout, admin, workers, migrate —
# starts FROM that stage, so BuildKit installs the workspace's 200+
# packages exactly once per build context. The expensive parallel work
# becomes just the Next compiles, which is what the VPS is actually
# provisioned for.
#
# Targets
# -------
#   deps              shared: pnpm install full workspace
#   src               shared: workspace + all source code copied in
#   migrate           one-shot: runs drizzle + raw SQL on boot (uses src
#                     plus psql; never serves traffic)
#   api-runtime       slim node image running tsx on apps/api/src/server.ts
#   dashboard-runtime slim node image serving `next start` for dashboard
#   checkout-runtime  same shape, port 3001
#   admin-runtime     same shape, port 3002
#   workers-runtime   slim node image running tsx on apps/workers/src/index.ts
#
# Runtime images still copy the FULL `/repo` tree so pnpm's per-package
# `node_modules/.bin` symlinks resolve — the api/workers run TypeScript
# source via `tsx`, so the `.ts` files have to ship in the image. This is
# a deliberate trade-off documented in apps/api/Dockerfile.deprecated.
# =============================================================================

ARG NODE_VERSION=22.22.0
ARG PNPM_VERSION=9.12.3

# -----------------------------------------------------------------------------
# Stage: deps
#   Install the entire workspace's dep graph. Cached on every package.json
#   list — only invalidated when a manifest changes. NODE_ENV=development
#   so pnpm keeps devDependencies (tsx, next, typescript, etc.) regardless
#   of what Coolify leaks at build time.
# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# Stage: base
#   Shared foundation for every other stage. Patches Debian system
#   libraries (glibc, gnutls, systemd, perl, gnupg, ...) so Snyk's
#   Dockerfile scanner doesn't flag ~95 stale-package CVEs on every
#   rebuild. Running the upgrade in ONE stage and chaining downstream
#   stages with `FROM base` means apt-upgrade only runs once per
#   build context — the cache layer is reused by deps + 5 runtimes.
#
# `apt-get -y upgrade` is safe inside a Docker build: the layer is
# frozen the moment the RUN finishes, so there's no in-place service
# disruption. We pin to no-install-recommends to keep the image slim.
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
# `dist-upgrade` is stronger than plain `upgrade`: it can add/remove
# packages to resolve dependency conflicts on security patches.
# `bookworm-slim` already ships `bookworm-security` inside its
# deb822-formatted `/etc/apt/sources.list.d/debian.sources` with the
# correct `Signed-By` key — no need to add a legacy `.list` file (and
# doing so trips an apt "Conflicting values set for option Signed-By"
# error). `apt-get update` here therefore pulls from main + security
# in one shot.
RUN apt-get update \
    && apt-get -y --no-install-recommends dist-upgrade \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

FROM base AS deps

ARG PNPM_VERSION

ENV NODE_ENV=development \
    PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}" \
    COREPACK_DEFAULT_TO_LATEST=0 \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

# Workspace root manifests first so a source-only change skips this layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./

# Every workspace package's manifest. The order doesn't matter — these
# are sibling COPYs that BuildKit hashes together into one layer.
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/checkout/package.json apps/checkout/
COPY apps/admin/package.json apps/admin/
COPY apps/workers/package.json apps/workers/
COPY packages/auth/package.json packages/auth/
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/audit/package.json packages/audit/
COPY packages/connect/package.json packages/connect/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY packages/emails/package.json packages/emails/
COPY packages/waha/package.json packages/waha/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Stage: src
#   Source code on top of `deps`. Every per-app builder stage starts here.
# -----------------------------------------------------------------------------
FROM deps AS src

COPY apps apps
COPY packages packages
# One-shot operational scripts (partner bootstrap, MP test-user
# generator). Kept out of the per-app builders to avoid changing the
# Next build hashes whenever a script lands.
COPY scripts scripts

# -----------------------------------------------------------------------------
# Stage: migrate
#   The migration runner. Used by docker-compose's `migrate` one-shot
#   service. Needs `psql` (drizzle migrate is JS, but the raw SQL files in
#   packages/db/sql + packages/audit/sql go through psql).
# -----------------------------------------------------------------------------
FROM src AS migrate
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# Stage: dashboard-builder → checkout-builder → admin-builder
#
# These three Next builds were originally fan-out from `src`, which let
# BuildKit run them in parallel. On a 4-vCPU / 8-GB VPS this peaks at
# ~3× the RAM of a single build, exceeding the headroom Coolify's
# helper container has, and Buildx kills the process with an opaque
# `internal load local bake definitions` error.
#
# Chaining them via FROM the previous-builder forces BuildKit's graph
# to serialize. Each stage still hits the cache when ONLY downstream
# source changed (the dashboard layer doesn't invalidate when only the
# checkout app changes — BuildKit hashes per-stage COPY independently)
# so the rebuild cost is bounded.
# -----------------------------------------------------------------------------
FROM src AS dashboard-builder
# Next.js bakes NEXT_PUBLIC_* envs into the client bundle at build
# time. Coolify only sets compose `environment:` at run time, which is
# too late for the static chunks. We accept them as build args here
# and re-export them as ENV so `next build` sees them — production
# domains live on `*.univercart.com` by default and can be overridden
# from compose for staging.
ARG NEXT_PUBLIC_API_URL=https://api.univercart.com
ARG NEXT_PUBLIC_CHECKOUT_URL=https://pay.univercart.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_CHECKOUT_URL=$NEXT_PUBLIC_CHECKOUT_URL
RUN NODE_ENV=production pnpm --filter @payunivercart/dashboard exec next build

FROM dashboard-builder AS checkout-builder
ARG NEXT_PUBLIC_API_URL=https://api.univercart.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN NODE_ENV=production pnpm --filter @payunivercart/checkout exec next build

FROM checkout-builder AS admin-builder
ARG NEXT_PUBLIC_API_URL=https://api.univercart.com
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN NODE_ENV=production pnpm --filter @payunivercart/admin exec next build

# -----------------------------------------------------------------------------
# Runtime stages — slim images that copy only what each service needs.
# -----------------------------------------------------------------------------

# api-runtime — tsx executes the .ts source. Full /repo tree copied so
# the per-package node_modules symlinks pnpm wrote are intact.
FROM base AS api-runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"
RUN groupadd --system --gid 10001 api \
    && useradd  --system --uid 10001 --gid api --no-create-home api
WORKDIR /repo
COPY --chown=api:api --from=src /repo /repo
USER api
EXPOSE 4000
CMD ["apps/api/node_modules/.bin/tsx", "apps/api/src/server.ts"]

# workers-runtime — same shape as api but boots the BullMQ processor.
FROM base AS workers-runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"
RUN groupadd --system --gid 10001 worker \
    && useradd  --system --uid 10001 --gid worker --no-create-home worker
WORKDIR /repo
COPY --chown=worker:worker --from=src /repo /repo
USER worker
CMD ["apps/workers/node_modules/.bin/tsx", "apps/workers/src/index.ts"]

# dashboard-runtime — standalone Next.js output. Copies only the self-
# contained bundle (~150 MB) instead of the full /repo tree (~1 GB).
# `output: standalone` in next.config.ts writes apps/dashboard/.next/standalone/
# which includes a pre-traced node_modules subset and server.js entry.
FROM base AS dashboard-runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 next \
    && useradd  --system --uid 10001 --gid next --no-create-home next
WORKDIR /app
COPY --chown=next:next --from=dashboard-builder /repo/apps/dashboard/.next/standalone ./
COPY --chown=next:next --from=dashboard-builder /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --chown=next:next --from=dashboard-builder /repo/apps/dashboard/public ./apps/dashboard/public
USER next
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]

# checkout-runtime — same standalone pattern, port 3001.
FROM base AS checkout-runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 next \
    && useradd  --system --uid 10001 --gid next --no-create-home next
WORKDIR /app
COPY --chown=next:next --from=checkout-builder /repo/apps/checkout/.next/standalone ./
COPY --chown=next:next --from=checkout-builder /repo/apps/checkout/.next/static ./apps/checkout/.next/static
COPY --chown=next:next --from=checkout-builder /repo/apps/checkout/public ./apps/checkout/public
USER next
EXPOSE 3001
CMD ["node", "apps/checkout/server.js"]

# admin-runtime — same standalone pattern, port 3002.
FROM base AS admin-runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3002 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 next \
    && useradd  --system --uid 10001 --gid next --no-create-home next
WORKDIR /app
COPY --chown=next:next --from=admin-builder /repo/apps/admin/.next/standalone ./
COPY --chown=next:next --from=admin-builder /repo/apps/admin/.next/static ./apps/admin/.next/static
COPY --chown=next:next --from=admin-builder /repo/apps/admin/public ./apps/admin/public
USER next
EXPOSE 3002
CMD ["node", "apps/admin/server.js"]
