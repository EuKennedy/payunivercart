# Architecture — payunivercart

> Why every technical decision was made.

This document captures the rationale behind each choice so a senior engineer joining tomorrow can understand the system in under ten minutes.

---

## 1. Product shape

payunivercart is a multi-tenant SaaS for digital product creators ("producers"). Each producer signs up, creates one or more **workspaces** (each billed at R$ 99,90/month), connects their own payment gateway credentials, builds branded checkouts, and recovers abandoned carts through WhatsApp and email automation.

We are an **orchestrator/gateway-proxy**, not a registered Payment Facilitator (PayFac). We do not custody funds. Producers configure their own credentials in Mercado Pago, Pagar.me, PagSeguro, or Stripe; settlements flow directly to the producer's gateway accounts. This removes regulatory burden (Bacen licensing, dispute reserve, KYC at our level) and lets us ship faster while still offering an "all-in-one panel" UX.

PayFac status remains a roadmap option once volume justifies the regulatory investment.

---

## 2. Monorepo & toolchain

| Choice             | Why                                                                                            |
|--------------------|------------------------------------------------------------------------------------------------|
| **pnpm 9**         | Strict, content-addressable store. Faster, smaller, deterministic vs npm/yarn.                 |
| **Turborepo 2**    | Remote-cacheable task graph. First-class with Vercel and Coolify Docker builds.                |
| **TypeScript 5.7** | `strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. |
| **Biome 1.9**      | Single Rust-powered formatter+linter. Replaces ESLint+Prettier, 10×–100× faster.                |
| **Node 22 LTS**    | Native fetch, stable test runner, modern V8.                                                   |

We refuse half-strict TypeScript. The base `tsconfig.base.json` enables every strict flag that catches real bugs.

---

## 3. Apps

### `apps/dashboard` — producer panel
Next.js 15 App Router with React Server Components. Side-to-side layout (fixed sidebar + content). Glassmorphism design system in dark and light modes. All producer modules live here: Dashboard, Products, Checkout builder, Recovery, Integrations, Finance, Settings.

### `apps/checkout` — public checkout
Separate Next.js app on its own subdomain (`checkout.univercart.com`). Isolation rationale: PCI scope reduction, deploy independence, sub-second LCP budget. Edge-rendered where possible. Loads only the gateway adapter the producer has selected.

### `apps/admin` — super admin
Internal-only panel for the platform owner. Global metrics, producer impersonation, workspace suspension, audit log review. Same design system as dashboard but restricted by RBAC and IP allowlist.

### `apps/api` — Hono + tRPC backend
Single source of business logic. Hono is the runtime (edge-compatible, fast); tRPC gives compile-time type safety across the Next clients. Authoritative for all writes; clients never touch the DB directly.

### `apps/workers` — BullMQ consumers
Async jobs: webhook delivery, abandoned cart recovery sequences, WhatsApp OTP send, email blasts, gateway reconciliation, dunning.

---

## 4. Packages

| Package         | Purpose                                                                          |
|-----------------|----------------------------------------------------------------------------------|
| `db`            | Drizzle schema + migrations. Source of truth for the data model.                |
| `payments`      | Per-gateway adapters (`MercadoPagoAdapter`, `PagarmeAdapter`, etc.) behind a shared interface. Smart routing layer above. |
| `auth`          | Better-Auth configuration shared by dashboard/admin/api.                         |
| `ui`            | shadcn/ui components customized for our glassmorphism system.                    |
| `emails`        | React Email templates rendered to HTML at send time.                             |
| `waha`          | Typed WAHA client and the phone normalizer (see §7).                             |
| `shared`        | Zod schemas, constants, error types reused by every workspace.                   |
| `i18n`          | `next-intl` locale bundles (PT-BR, EN, ES).                                      |

Every package compiles standalone, has its own `tsconfig.json` extending `tsconfig.base.json`, and exposes a typed `index.ts` entry point.

---

## 5. Data model (high level)

Multi-tenant isolation pattern: **every domain row carries `workspace_id`**. Postgres Row-Level Security policies enforce isolation at the database layer; the application layer never relies on filters alone.

Core tables:

- `users`, `sessions`, `accounts` — Better-Auth managed
- `organizations` — billing entity per producer
- `workspaces` — isolated tenants under an organization, individually billed
- `memberships` — RBAC links between users and workspaces
- `products`, `product_variants`, `product_offers`, `order_bumps`
- `checkouts` — JSONB configuration of fields, methods, branding
- `gateway_credentials` — encrypted (libsodium sealed boxes) per workspace
- `orders`, `order_items`
- `transactions` — every payment attempt (idempotent, append-only)
- `payment_tokens` — gateway-issued, never PAN
- `subscriptions`, `subscription_invoices`
- `carts` — abandoned recovery candidates (TTL in Redis, persisted on conversion)
- `recovery_campaigns`, `recovery_messages` — WhatsApp/email sequences
- `integrations` — third-party connections (WAHA sessions, ESPs, webhooks)
- `webhooks_outbox` — transactional outbox pattern for exactly-once delivery
- `events_audit` — append-only hash-chained audit log
- `platform_invoices` — our own SaaS billing per workspace (R$ 99,90/mo)

---

## 6. Payments orchestration

A single `PaymentGateway` interface is implemented by per-provider adapters:

```ts
interface PaymentGateway {
  readonly id: GatewayId;
  validateCredentials(creds: unknown): Promise<Result<GatewayContext>>;
  createPayment(ctx: GatewayContext, input: CreatePaymentInput): Promise<Payment>;
  capturePayment(ctx: GatewayContext, id: string): Promise<Payment>;
  refundPayment(ctx: GatewayContext, id: string, amount?: number): Promise<Refund>;
  verifyWebhook(ctx: GatewayContext, req: WebhookRequest): Promise<WebhookEvent | null>;
}
```

Routing rules:
- Producer picks **one preferred BR gateway** (MP, Pagar.me, or PagSeguro) for Pix/cartão/boleto.
- Stripe activates only when the producer connects it and selects it as the USD gateway.
- Each transaction is dispatched through the adapter with an idempotency key.

Webhook handling:
- Inbound webhooks land on `apps/api`, signature-verified per gateway, deduplicated via a Redis seen-set with TTL.
- Outbound delivery to producer-defined URLs uses the **transactional outbox** pattern with exponential backoff and dead-letter queue.

---

## 7. WhatsApp & phone normalization

We use **WAHA** (self-hosted on Docker) with the `webjs` engine, *not* Evolution API.

The `webjs` engine strips the extra "9" digit from Brazilian mobile numbers. A user types `(31) 98495-6383`, but WAHA expects `553184956383`. To handle this robustly across countries:

- Frontend preserves whatever the user typed (`phone_raw`).
- Backend stores a second column (`phone_normalized`) produced by `packages/waha`'s `normalizeToWaha(input, defaultCountry)` utility, built on `libphonenumber-js`.
- For BR mobile numbers, the normalizer strips the leading `9` after the area code. For every other country, it preserves the E.164 form.
- Every outbound WhatsApp call uses `phone_normalized`; every UI render uses `phone_raw`.

This rule is non-negotiable — any code path that talks to WAHA must go through the normalizer.

---

## 8. Auth

Better-Auth is configured with:
- Email + password (argon2id)
- Mandatory second factor: OTP delivered via WAHA **or** Resend, user-selectable per login
- Optional TOTP for security-conscious users
- 15-minute JWT access tokens, Redis-backed refresh tokens
- Per-IP and per-user rate limits on the login route

---

## 9. Security baselines (day one)

- **PCI**: PAN never touches our infrastructure. All cards tokenized inside the gateway iframe/SDK.
- **Secrets at rest**: gateway credentials and integration tokens encrypted using libsodium sealed boxes; the master key lives in environment-managed secret store (Doppler/Infisical in prod).
- **Transport**: HTTPS everywhere, HSTS preload, strict CSP, Permissions-Policy.
- **Rate limiting**: Upstash-style sliding-window limits per IP, per organization, per endpoint.
- **Audit log**: append-only `events_audit` with HMAC-chained hashes; reviewed in the super-admin panel.
- **LGPD**: consent records, data export, right-to-erasure endpoints from day one.
- **Webhook outbox + idempotency keys**: exactly-once delivery semantics.

---

## 10. Observability

- Errors → Sentry
- Product analytics + session replay → PostHog (self-host option on Coolify if desired)
- Distributed tracing → OpenTelemetry → Axiom (or Tempo if self-hosted)
- Health/liveness/readiness probes for every container

---

## 11. Deployment

Production runs on a single VPS with Coolify orchestrating Docker Compose. Coolify reads `docker/docker-compose.yml`; each service has its own Dockerfile under `docker/`. Migrations run as a one-shot job before `apps/api` starts.

Domains:
- `pay.univercart.com` → `apps/dashboard`
- `checkout.univercart.com` → `apps/checkout`
- `admin.univercart.com` → `apps/admin`
- `api.univercart.com` → `apps/api`
- `waha.univercart.internal` → WAHA (internal-only via Cloudflare Tunnel or firewall rules)

---

## 12. Out of scope for V1

- Affiliate program (UTM links, payout flows)
- Visual drag-and-drop checkout builder
- Marketplace of products
- Native PayFac registration

These are reserved in the data model and routes but not implemented.
