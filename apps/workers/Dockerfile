# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.3

FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Re-import the global ARG into this stage's scope.
ARG PNPM_VERSION

ENV PNPM_HOME=/pnpm \
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

RUN pnpm --filter @payunivercart/workers build
RUN pnpm --filter @payunivercart/workers... --prod deploy /repo/runtime

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

RUN groupadd --system --gid 10001 worker \
    && useradd  --system --uid 10001 --gid worker --no-create-home worker

WORKDIR /app

COPY --chown=worker:worker --from=builder /repo/runtime/dist ./dist
COPY --chown=worker:worker --from=builder /repo/runtime/node_modules ./node_modules
COPY --chown=worker:worker --from=builder /repo/runtime/package.json ./package.json

USER worker

CMD ["node", "dist/index.js"]
