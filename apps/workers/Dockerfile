# syntax=docker/dockerfile:1.7

# =========================================================================
# @payunivercart/workers — BullMQ processors.
#
# See apps/api/Dockerfile for the rationale on running `.ts` via tsx in
# production. Same pattern applies here.
# =========================================================================

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.3

# -------------------------------------------------------------------------
# Builder
# -------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

ARG PNPM_VERSION

ENV NODE_ENV=development \
    PNPM_HOME=/pnpm \
    PATH="/pnpm:${PATH}" \
    COREPACK_DEFAULT_TO_LATEST=0

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY tsconfig.base.json ./

COPY apps/workers/package.json apps/workers/
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY packages/audit/package.json packages/audit/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY packages/waha/package.json packages/waha/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps/workers apps/workers
COPY packages packages

# -------------------------------------------------------------------------
# Runtime
# -------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

RUN groupadd --system --gid 10001 worker \
    && useradd  --system --uid 10001 --gid worker --no-create-home worker

WORKDIR /repo

COPY --chown=worker:worker --from=builder /repo /repo

USER worker

CMD ["node_modules/.bin/tsx", "apps/workers/src/index.ts"]
