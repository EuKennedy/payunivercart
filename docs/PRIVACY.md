# Privacy & PII inventory

This document maps the personal data the platform persists, the legal
basis we rely on under the **LGPD** (Law 13.709/2018), and the
sub-processors we share it with. Keep it current — every audit, RFI,
or DPO inquiry starts here.

## Categories

| Category | Definition | Examples |
|----------|-----------|---------|
| **PII-1 (identification)** | Data that directly identifies a natural person. | `users.email`, `users.name`, `orders.customer_name` |
| **PII-2 (sensitive identifiers)** | Government-issued numbers + contact channels. | `orders.customer_document` (CPF/CNPJ), `orders.customer_phone_e164` |
| **PII-3 (financial)** | Payment metadata. NEVER raw PAN/CVV — only gateway tokens and last-4. | `transactions.card_brand`, `transactions.card_last4`, `gateway_credentials.credentials_encrypted` |
| **PII-4 (behavioral)** | Cart / order activity tied to an identified user. | `carts.items_snapshot`, `orders.metadata`, `events_audit.diff` |

## Where each field lives

| Field | Table | Category | Notes |
|-------|-------|----------|-------|
| Email | `users.email`, `orders.customer_email`, `carts.customer_email` | PII-1 | Indexed for dedupe; not encrypted at rest (re-evaluate when traffic exceeds 5k orders/day). |
| Name | `users.name`, `orders.customer_name` | PII-1 | Plain text. |
| CPF / CNPJ | `orders.customer_document` | PII-2 | Plain text (digits-only); validated against Receita Federal mod-11. Required by every gateway for KYC. |
| Phone (E.164) | `orders.customer_phone_e164`, `users.phone_*` (future) | PII-2 | Plain text; resolved to WAHA chatId via `whatsapp_chat_ids` cache. |
| Phone (raw, as typed) | `orders.customer_phone_raw` | PII-2 | Kept verbatim for forensic auditability; never re-displayed to other tenants. |
| IP address | `orders.ip_address`, `events_audit.actor_ip` | PII-2 | LGPD treats IP as PII when combined with another identifier (we always combine). |
| User agent | `orders.user_agent` | PII-1 | Tied to a session/order. |
| Card brand + last 4 | `transactions.card_brand`, `transactions.card_last4` | PII-3 | Sub-PII per PCI-DSS — non-sensitive in isolation. |
| Card PAN / CVV | **NEVER stored.** | — | Tokenized in-browser; the gateway returns a short-lived `payment_method` we relay server-side. SAQ-A scope. |
| Gateway secret keys | `gateway_credentials.credentials_encrypted` | PII-3 | Sealed-box ciphertext via `packages/crypto` (AES-256-GCM, 32-byte KEK, versioned `key_id`). Plaintext lives only in RAM during a request. |
| Bank account info | Not stored (handled by gateway). | — | Payouts go to the producer's account held with the gateway, not us. |
| Two-factor secret | `two_factor.secret` | PII-3 | Currently `text()` — the bootstrap validator will encrypt before write when Better-Auth lands. |
| Backup codes | `two_factor.backup_codes` | PII-3 | Same plan: hash each code with argon2id before write. |

## Legal basis (LGPD Art. 7)

| Activity | Basis |
|----------|-------|
| Process payments | Art. 7 V — execution of contract. |
| Send transactional WAHA / email notifications (order confirmation, OTP) | Art. 7 V — contract. |
| Cart-recovery campaigns | Art. 7 IX — legitimate interest. Customer can opt out per producer. |
| Anti-fraud, chargeback handling | Art. 7 IX — legitimate interest. |
| Audit log retention (7 years) | Art. 7 II — compliance with legal/regulatory obligation (CVM, Receita). |

## Sub-processors (Art. 11 §1 II)

Producers MUST disclose these to their own customers. We surface this
list in the dashboard's onboarding wizard.

| Sub-processor | Purpose | Data shared | Region |
|---------------|---------|-------------|--------|
| **Mercado Pago** | Payment processing | Order amount, customer name/email/CPF, card token, billing address | Brazil |
| **Pagar.me (Stone)** | Payment processing | Same | Brazil |
| **PagSeguro / PagBank** | Payment processing | Same | Brazil |
| **Stripe Brasil** | Payment processing (BRL + USD) | Same plus shipping address for boleto | US + Brazil |
| **Resend** | Transactional email delivery | Recipient email, message body | US (Inflight: EU DPA in progress) |
| **WAHA (self-hosted)** | WhatsApp gateway | Recipient phone E.164, message body | Self-hosted on our VPS — NOT a third-party sub-processor. |
| **Cloudflare** | Edge / CDN / WAF | IP, request metadata | Global |
| **Coolify VPS host (Hetzner)** | Hosting | All data at rest | Germany |
| **Sentry** (planned) | Error monitoring | Stack traces — scrubbed of user PII by Sentry SDK config | EU |
| **PostHog** (planned, EU instance) | Product analytics | Pseudonymous user id, event metadata | EU |

## Retention

- `events_audit`: 7 years (SOX / Receita).
- `orders`, `transactions`, `refunds`: 5 years after last activity (CVM Resolution 35).
- `carts` (non-converted): 90 days.
- `webhooks_inbound`: 30 days (debugging window).
- Soft-delete on `workspaces` / `users` (`deleted_at`) keeps the row reachable for the audit period but blocks app-side reads via RLS.

## Subject rights (Art. 18)

| Right | How we serve it |
|-------|-----------------|
| Access / portability | `/api/me/export` returns a JSON archive of every PII row tied to the requesting `user.id`. Workspace owner can export per-customer via the dashboard. |
| Correction | Self-service in the dashboard for email/name/phone; CPF/CNPJ requires DPO approval (anti-fraud). |
| Anonymization / deletion | Soft-delete via `users.deleted_at` / `workspaces.deleted_at`. Audit log rows are NOT deleted (legal-obligation basis); we replace `actor_user_id` with a stable pseudonym and overwrite identification fields with `[REDACTED]`. |
| Revoke consent | Cart-recovery + marketing opt-out toggles in the customer's confirmation email and on the dashboard's customer profile. |

## Incident response

- Discovery → DPO notified within 1 business hour.
- ANPD notification: within 72 hours of confirmed breach.
- Customer notification: producer's responsibility — we provide the list of affected rows + timestamps within 24 hours of ANPD filing.
- Post-mortem committed to `docs/incidents/<YYYY-MM-DD>-<slug>.md`.

## Updating this document

Any new column, sub-processor, or retention change MUST update this
file in the same PR. The CI lint job will be extended in a future block
to fail when a new tenant-table column lands without a row here.
