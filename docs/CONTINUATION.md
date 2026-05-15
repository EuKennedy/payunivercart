# CONTINUATION — Resume Point

> Last save: 2026-05-14. Pick up tomorrow from here without re-deriving context.

## State of the union

**Done**
- Monorepo scaffolded: pnpm 9 + Turborepo 2 + TypeScript 5.7 strict-max + Biome.
- Root configs: `package.json`, `tsconfig.base.json`, `biome.json`, `turbo.json`, `pnpm-workspace.yaml`, `.env.example`, `.gitignore`, `.editorconfig`, `.nvmrc`, `.dockerignore`.
- Architecture doc: `docs/ARCHITECTURE.md`.
- Research docs: `docs/research/payment-gateways.md` (4 gateways), `docs/research/waha-webjs.md` (WAHA web.js BR quirk).
- `packages/shared`: errors taxonomy (`PayunivercartError`), `Result<T,E>`, constants (`GATEWAY_IDS`, `WORKSPACE_MONTHLY_PRICE_BRL=99.90`), phone normalizer (`normalizePhone` → `guessedWahaChatId` best-effort).
- `packages/waha`: HTTP client (`WahaClient.checkExists/sendText/getSessionStatus/startSession/getQr`), `ChatIdResolver` (check-exists + 30d cache; `InMemoryChatIdCache` impl), webhook verifier (HMAC-SHA512 timingSafeEqual).
- `packages/db`: full Drizzle schema (auth, organizations, workspaces, memberships RBAC, integrations, gatewayCredentials encrypted, whatsappSessions, whatsappChatIds cache, products, productOffers, checkouts, orders, transactions append-only, refunds, carts, recovery, webhooks in/out/endpoints, eventsAudit hash chain, platformSubscriptions, platformInvoices).
- `packages/payments`: `PaymentGateway<TCredentials>` interface, all 4 zod credential schemas, decline-code taxonomy + `PaymentError`, registry with lazy singleton.
- **Stripe adapter: fully implemented** (createCard / createPix BRL / createBoleto BRL / refund / getCharge / verifyWebhook via `stripe.webhooks.constructEvent`, error mapping).
- **MP / Pagar.me / PagSeguro adapters: typed shells** — parseCredentials works, every other method throws `INTERNAL 501 — not implemented yet`. Registry compiles cleanly.

**Not started**
- HTTP integration for MP, Pagar.me, PagSeguro adapters.
- Any `apps/*` (dashboard, checkout, admin, api, workers) — zero scaffolding.
- `packages/ui` design system (shadcn + glassmorphism Apple Night Shift).
- `packages/emails` (React Email).
- `packages/auth` (Better-Auth wiring email+senha+OTP via WAHA/Email).
- `packages/i18n` (next-intl PT-BR/EN/ES).
- Docker Compose stack (postgres, redis, waha, apps, nginx).
- Coolify deploy config.
- First Drizzle migration generation.
- Better-Auth schema reconciliation with our `auth` schema in `packages/db`.

## Tomorrow start order

1. **`pnpm install`** at repo root, confirm workspace links resolve.
2. **`pnpm typecheck`** — verify foundation compiles green. Fix any TS drift before touching new code.
3. **Implement Pix-first HTTP integration** for the BR adapters in this order (Pix is the priority payment method):
   - MercadoPago: `POST /v1/payments` with `payment_method_id=pix`, manifest HMAC verify on webhook.
   - Pagar.me v5: `POST /core/v5/orders` with `payments[].payment_method=pix`, Basic Auth, no HMAC (endpoint-secured).
   - PagSeguro Orders: `POST /orders` with `qr_codes[]`, notification token header verify.
   - Card + Boleto land in same pass per adapter.
4. **Scaffold `apps/api`** — Hono + tRPC, mount payments router, wire credential decryption (libsodium sealed boxes).
5. **Scaffold `apps/dashboard`** — Next.js 15 App Router + React 19 + Tailwind v4 + shadcn. Glassmorphism design tokens first, then routes.
6. **Docker Compose** — pin versions: postgres:17, redis:7, devlikeapro/waha-plus (web.js engine), app images.
7. **Better-Auth** wiring + OTP channel selector (WAHA / Email post-login).
8. **First migration** via `pnpm db:generate && pnpm db:migrate`.
9. **Coolify** compose file at `docker/coolify.compose.yml` for `pay.univercart.com`.

## Watch-outs (don't lose these)

- **WAHA BR 9-digit**: never compute chatId blindly. Always `ChatIdResolver.resolve()` → check-exists → cache 30d. Pre-2012 vs post-2012 accounts differ. Other DDIs unaffected.
- **Producer brings own gateway keys** — we are orchestrator, NOT PayFac. PCI scope = SAQ A (tokens only).
- **Idempotency**: deterministic UUIDv5 per (workspaceId, orderId, gatewayId) before any gateway POST.
- **Webhook signature algos differ**: Stripe SHA-256 + `stripe-signature`; MP manifest SHA-256; Pagar.me Basic Auth on endpoint; PagSeguro shared token header; WAHA SHA-512.
- **Transactions table is append-only**. No UPDATE. State transitions via new rows + view.
- **Audit log** uses hash chain — `prev_hash + row_hash`. Anything touching money writes here.
- **Multi-tenant**: every domain row has `workspace_id` + Postgres RLS policy. Test RLS in CI.
- **Workspace billing**: R$99,90/month per workspace, charged on the platform's own Stripe/Pagar.me account (separate from producer's gateways).

## Repo

- Local: `/Users/OPERACOES/payunivercart`
- Remote: `https://github.com/EuKennedy/payunivercart`
- Commit identity: kennedy.rodrigues1104@gmail.com (NOT as collaborator).
- GH token rotates every 6h — re-issue before push if stale.

## Memory pointers

- `~/.claude/projects/-Users-OPERACOES-payunivercart/memory/MEMORY.md` — index.
- `project_payunivercart.md` — full project state & decisions.
- `feedback_phone_normalization.md` — WAHA chatId resolver rule.
