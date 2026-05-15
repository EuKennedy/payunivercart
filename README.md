# payunivercart

> Payment facilitator platform for digital product creators.

Multi-tenant SaaS where digital product creators manage products, build customized checkouts, integrate their own payment gateway credentials (Mercado Pago, Pagar.me, PagSeguro, Stripe), recover abandoned carts via WhatsApp and email, and track end-to-end performance — all in a premium glassmorphism dashboard.

---

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment variables
cp .env.example .env
# edit .env with your local secrets

# 3. Boot infrastructure (Postgres, Redis, WAHA)
pnpm docker:up

# 4. Run migrations
pnpm db:migrate

# 5. Start everything in dev mode
pnpm dev
```

| App           | URL                       |
|---------------|---------------------------|
| Dashboard     | http://localhost:3000     |
| Checkout      | http://localhost:3001     |
| Super Admin   | http://localhost:3002     |
| API (tRPC)    | http://localhost:4000     |
| Drizzle Studio| `pnpm db:studio`          |

---

## Monorepo layout

```
.
├── apps/
│   ├── dashboard/    # Next.js 15 — producer panel (pay.univercart.com)
│   ├── checkout/     # Next.js 15 — public checkout (checkout.univercart.com)
│   ├── admin/        # Next.js 15 — super-admin internal panel
│   ├── api/          # Hono + tRPC — type-safe backend
│   └── workers/      # BullMQ workers — async jobs
├── packages/
│   ├── db/           # Drizzle ORM schema + migrations
│   ├── payments/     # Gateway adapters (MP, Pagar.me, PagSeguro, Stripe)
│   ├── auth/         # Better-Auth config (email+password+OTP)
│   ├── ui/           # shadcn/ui design system (glassmorphism)
│   ├── emails/       # React Email templates
│   ├── waha/         # WAHA client + phone normalizer
│   ├── shared/       # Types, zod schemas, utilities
│   └── i18n/         # PT-BR, EN, ES locale bundles
├── docker/           # docker-compose, service Dockerfiles
└── docs/             # Architecture, research, runbooks
```

---

## Stack

- **Runtime**: Node.js 22 LTS, pnpm 9, Turborepo 2
- **Web**: Next.js 15 (App Router) + React 19 + Tailwind v4 + shadcn/ui
- **API**: Hono + tRPC (type-safe end-to-end)
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Cache & Queue**: Redis + BullMQ
- **Auth**: Better-Auth (email + password + OTP via WAHA or Resend)
- **WhatsApp**: WAHA (self-hosted, `webjs` engine)
- **Email**: Resend + React Email
- **Tooling**: TypeScript 5.7 strict, Biome, Vitest, Playwright
- **Observability**: Sentry, PostHog, OpenTelemetry
- **Deployment**: Docker Compose orchestrated by Coolify on `pay.univercart.com`

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full rationale behind each choice.

---

## Scripts

| Command              | Description                          |
|----------------------|--------------------------------------|
| `pnpm dev`           | Run all apps in dev mode (parallel)  |
| `pnpm build`         | Build every app and package          |
| `pnpm lint`          | Biome lint                           |
| `pnpm lint:fix`      | Biome autofix                        |
| `pnpm typecheck`     | TypeScript across the monorepo       |
| `pnpm test`          | Run all package tests                |
| `pnpm db:generate`   | Generate Drizzle migrations          |
| `pnpm db:migrate`    | Apply migrations                     |
| `pnpm db:studio`     | Launch Drizzle Studio                |
| `pnpm docker:up`     | Boot local Postgres/Redis/WAHA stack |
| `pnpm docker:down`   | Stop infrastructure                  |

---

## License

UNLICENSED — proprietary. All rights reserved.
