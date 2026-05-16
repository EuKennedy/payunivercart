# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.11.0
ARG PNPM_VERSION=9.12.3

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
    COREPACK_DEFAULT_TO_LATEST=0 \
    NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc tsconfig.base.json ./

COPY apps/dashboard/package.json apps/dashboard/
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

COPY apps/dashboard apps/dashboard
COPY apps/api apps/api
COPY packages packages

# Next.js standalone output keeps the runtime image to ~120 MB.
RUN pnpm --filter @payunivercart/dashboard exec next build --webpack

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 10001 next \
    && useradd  --system --uid 10001 --gid next --no-create-home next

WORKDIR /app

# Next 16 emits a self-contained `standalone/` tree when configured.
# Our `next.config.ts` does NOT set `output: 'standalone'` yet so we
# copy the full `.next` + node_modules; flip to standalone in a later
# block once we're sure every dynamic import is reachable.
COPY --chown=next:next --from=builder /repo/apps/dashboard/.next ./.next
COPY --chown=next:next --from=builder /repo/apps/dashboard/public ./public
COPY --chown=next:next --from=builder /repo/apps/dashboard/package.json ./package.json
COPY --chown=next:next --from=builder /repo/apps/dashboard/next.config.ts ./next.config.ts
COPY --chown=next:next --from=builder /repo/node_modules ./node_modules

USER next

EXPOSE 3000

CMD ["node_modules/.bin/next", "start", "-p", "3000"]
