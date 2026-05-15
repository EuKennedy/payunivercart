# Payment Gateways — Technical Reference

**Project:** payunivercart (Brazilian payment facilitator)
**Audience:** payment adapter layer engineers
**Date:** 2026-05-14
**Status:** Foundation research — verified against official docs (May 2026)

This document is the source of truth for integrating with the four supported gateways using the merchant's own credentials. Every endpoint, header and field below was verified against the official documentation. Where the live doc was unreachable, it is flagged explicitly in the "Gaps & open questions" section at the end.

---

## Table of contents

1. [Mercado Pago](#1-mercado-pago)
2. [Pagar.me](#2-pagarme)
3. [PagSeguro / PagBank](#3-pagseguro--pagbank)
4. [Stripe](#4-stripe)
5. [Comparison matrix](#5-comparison-matrix)
6. [Adapter-layer recommendations](#6-adapter-layer-recommendations)
7. [Gaps & open questions](#7-gaps--open-questions)

---

## 1. Mercado Pago

Official docs root: <https://www.mercadopago.com.br/developers/pt/docs>
API base URL: `https://api.mercadopago.com`

### A. Authentication credentials

| Credential | Purpose | Lives in |
|---|---|---|
| `access_token` (server) | All server-to-server calls | Authorization header |
| `public_key` (client) | Card tokenization in browser | Frontend SDK |
| `client_id` / `client_secret` | OAuth (for marketplace mode only) | Server only |

- Format prefixes: `APP_USR-...` (prod) and `TEST-...` (sandbox).
- The merchant generates them in the Mercado Pago developer panel ("Suas integrações" → application credentials), in two tabs: **Produção** and **Teste**. We do **not** need separate API hosts — the same `api.mercadopago.com` serves both; the environment is determined by which token is sent.
- Header: `Authorization: Bearer <ACCESS_TOKEN>`.
- **Credential validation endpoint:** `GET https://api.mercadopago.com/users/me` — returns the account profile (id, site_id, email). A 401 means the token is invalid. We will use this on credential save.
- **OAuth flow:** only required for marketplace/aggregator mode where payunivercart would collect on behalf of sub-merchants. Since the merchant brings their own access_token, we **skip OAuth** for v1. If we later need marketplace mode, the endpoint is `POST /oauth/token` with `grant_type=authorization_code`.

### B. Payment creation endpoints

All payments use a single endpoint:

```
POST https://api.mercadopago.com/v1/payments
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
X-Idempotency-Key: <uuid-v4>
```

#### B.1 Pix

```json
{
  "transaction_amount": 24.50,
  "description": "Pedido #12345",
  "payment_method_id": "pix",
  "payer": {
    "email": "buyer@example.com",
    "first_name": "Joao",
    "last_name": "Silva",
    "identification": { "type": "CPF", "number": "19119119100" }
  },
  "notification_url": "https://api.payunivercart.com/webhooks/mp/<merchant_id>",
  "external_reference": "ORDER-12345",
  "date_of_expiration": "2026-05-14T23:59:59.000-03:00"
}
```

Response (201) — key fields:

```json
{
  "id": 20359978,
  "status": "pending",
  "status_detail": "pending_waiting_transfer",
  "point_of_interaction": {
    "transaction_data": {
      "qr_code": "00020126600014br.gov.bcb.pix...",        // copia-cola
      "qr_code_base64": "iVBORw0KGgo...",                   // PNG base64
      "ticket_url": "https://www.mercadopago.com.br/payments/.../ticket"
    }
  }
}
```

#### B.2 Credit card

The card MUST be tokenized in the browser via the MP JS SDK using the `public_key`; we receive an opaque `token` (single-use, ~7 min TTL) which we relay server-side.

```json
{
  "transaction_amount": 199.90,
  "description": "Pedido #12345",
  "payment_method_id": "visa",
  "token": "ff8080814c11e237014c1ff593b57b4d",
  "installments": 3,
  "payer": {
    "email": "buyer@example.com",
    "identification": { "type": "CPF", "number": "19119119100" }
  },
  "notification_url": "https://api.payunivercart.com/webhooks/mp/<merchant_id>",
  "external_reference": "ORDER-12345",
  "statement_descriptor": "PAYUNIVERCART",
  "capture": true
}
```

- `installments`: 1–12 (issuer-dependent; some allow 1–18).
- `payment_method_id` values commonly used in BR: `visa`, `master`, `amex`, `elo`, `hipercard`.
- For 3DS, send `three_d_secure_mode: "optional"` (or `mandatory`); response will include `three_ds_info.external_resource_url` when challenge is needed.

#### B.3 Boleto

```json
{
  "transaction_amount": 199.90,
  "description": "Pedido #12345",
  "payment_method_id": "bolbradesco",
  "payer": {
    "email": "buyer@example.com",
    "first_name": "Joao",
    "last_name": "Silva",
    "identification": { "type": "CPF", "number": "19119119100" },
    "address": {
      "zip_code": "01310100",
      "street_name": "Av. Paulista",
      "street_number": "1000",
      "neighborhood": "Bela Vista",
      "city": "São Paulo",
      "federal_unit": "SP"
    }
  },
  "date_of_expiration": "2026-05-21T23:59:59.000-03:00",
  "notification_url": "https://api.payunivercart.com/webhooks/mp/<merchant_id>",
  "external_reference": "ORDER-12345"
}
```

Other valid boleto-class `payment_method_id`: `pec` (pagamento em lotérica). Response provides `transaction_details.external_resource_url` (PDF) and `barcode.content` (digitable line).

### C. Webhook handling

- **Configuration:** merchant sets the URL in panel ("Notificações → Webhooks") OR we set per-call via `notification_url`. The dashboard URL gives a per-application **secret** used for signature.
- **Signature header:** `x-signature: ts=<unix>,v1=<hmac_hex>` plus `x-request-id: <uuid>`.
- **Verification (HMAC-SHA256):**
  1. parse `ts` and `v1` from `x-signature`
  2. build manifest: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
  3. `hmac_sha256(secret, manifest).hexdigest()` must equal `v1`
  4. reject if `now - ts > 5 min` (replay protection — our policy, not enforced by MP)
- **Retry:** 22 s timeout; retries every 15 min until 200/201 is received. No documented max attempts cap — we should make webhook processing strictly idempotent.
- **Topics we handle:** `payment` (events `payment.created`, `payment.updated`), `chargebacks`, `topic_claims_integration_wh` (disputes), `merchant_order`. We poll-confirm by calling `GET /v1/payments/{id}` from the notification — never trust webhook payload alone.

### D. Refund / cancellation

```
POST https://api.mercadopago.com/v1/payments/{id}/refunds
Authorization: Bearer <ACCESS_TOKEN>
X-Idempotency-Key: <uuid>
Content-Type: application/json
```

Body: omit for full refund; `{ "amount": 50.00 }` for partial. Multiple partial refunds allowed until original total. Time limit: documented as "payment_too_old_to_be_refunded" — empirically ~180 days for cards, ~90 days for Pix.

Cancellation (before approval): `PUT /v1/payments/{id}` with `{ "status": "cancelled" }`.

### E. Idempotency

Header: `X-Idempotency-Key: <uuid-v4>`. **Required on all mutating endpoints.** Mercado Pago dedupes for 24 h.

### F. Rate limits

Not publicly documented as a hard number. Empirically ~250 req/s per access_token; bursts return HTTP 429. Implement exponential backoff (250 ms → 8 s, jitter, 5 attempts max).

### G. Error codes

```json
{ "message": "...", "error": "bad_request", "status": 400, "cause": [{"code": "...", "description": "..."}] }
```

Status-detail values we map (non-exhaustive):

| status / status_detail | Meaning | Retry? |
|---|---|---|
| approved / accredited | Success | — |
| pending / pending_contingency | Manual review | no, wait webhook |
| pending / pending_waiting_payment | Pix/boleto awaiting payer | no |
| rejected / cc_rejected_insufficient_amount | Insufficient funds | no |
| rejected / cc_rejected_call_for_authorize | Issuer call | no, user action |
| rejected / cc_rejected_bad_filled_security_code | Wrong CVV | no, user retry |
| rejected / cc_rejected_high_risk | Fraud filter | no |
| in_process | Async review | no, wait webhook |

### H. SDK recommendation

Official: [`mercadopago`](https://github.com/mercadopago/sdk-nodejs) v2.12.1 (May 2026), TypeScript, Node ≥16. **Use it.** Install: `npm install mercadopago`.

### I. Test data

- Test access token starts with `TEST-`.
- Test cards (any future expiry):

| Brand | Number | CVV |
|---|---|---|
| Mastercard | 5031 4332 1540 6351 | 123 |
| Visa | 4235 6477 2802 5682 | 123 |
| Amex | 3753 651535 56885 | 1234 |
| Elo (debit) | 5067 7667 8388 8311 | 123 |

- Outcome is driven by **cardholder name**: `APRO` (approved), `OTHE` (rejected general), `CONT` (pending), `CALL` (call authorize), `FUND` (insufficient funds), `SECU` (bad CVV), `EXPI` (expired), `FORM` (form error). Combine with test CPF `12345678909`.
- Pix in sandbox returns a real QR; mark paid via MP simulator (panel → Activities → Approve).

---

## 2. Pagar.me

Official docs root: <https://docs.pagar.me/>
API base URL: `https://api.pagar.me/core/v5`

### A. Authentication credentials

| Credential | Purpose | Format |
|---|---|---|
| `secret_key` (server) | All API calls | `sk_test_*` / `sk_live_*` |
| `public_key` (client) | Card tokenization | `pk_test_*` / `pk_live_*` |

- Header: HTTP Basic auth with `secret_key` as username and **empty password** (note the trailing colon):
  `Authorization: Basic ` + base64(`sk_live_xxx:`)
- Environment is determined by prefix (`_test_` vs `_live_`), same host.
- **Validation endpoint:** `GET https://api.pagar.me/core/v5/balance` (returns the merchant balance; 401 if key is wrong). Alternative: `GET /merchants/me`.
- No OAuth — keys are per-merchant only.

### B. Payment creation endpoints

Single endpoint creates orders with one or many payment methods:

```
POST https://api.pagar.me/core/v5/orders
Authorization: Basic <base64(sk_xxx:)>
Content-Type: application/json
Idempotency-Key: <uuid-v4>
```

Common envelope:

```json
{
  "code": "ORDER-12345",
  "customer": {
    "name": "João Silva",
    "email": "buyer@example.com",
    "document": "19119119100",
    "document_type": "CPF",
    "type": "individual",
    "phones": { "mobile_phone": { "country_code": "55", "area_code": "11", "number": "988887777" } }
  },
  "items": [
    { "code": "SKU-1", "amount": 19990, "description": "Produto X", "quantity": 1 }
  ],
  "payments": [ /* see below — amounts in CENTS */ ]
}
```

#### B.1 Pix payment

```json
"payments": [{
  "payment_method": "pix",
  "pix": {
    "expires_in": 3600,
    "additional_information": [
      { "name": "Pedido", "value": "ORDER-12345" }
    ]
  }
}]
```

Response → `charges[0].last_transaction`:

```json
{
  "qr_code": "00020101021226...",          // copia-cola
  "qr_code_url": "https://api.pagar.me/.../qrcode.png",
  "expires_at": "2026-05-14T15:00:00Z"
}
```

#### B.2 Credit card

Card MUST be tokenized via `POST /core/v5/tokens?appId=<public_key>` from the browser. Server then references the token:

```json
"payments": [{
  "payment_method": "credit_card",
  "credit_card": {
    "installments": 3,
    "statement_descriptor": "PAYUNIVERCART",
    "card_token": "token_xxx",
    "operation_type": "auth_and_capture"
  }
}]
```

Direct card data (avoid for PCI scope — only use server-side if PCI-DSS L1):

```json
"credit_card": {
  "installments": 3,
  "statement_descriptor": "PAYUNIVERCART",
  "card": {
    "number": "4000000000000010",
    "holder_name": "JOAO SILVA",
    "exp_month": 12, "exp_year": 30, "cvv": "123",
    "billing_address": {
      "line_1": "1000, Av. Paulista, Bela Vista",
      "zip_code": "01310100", "city": "São Paulo",
      "state": "SP", "country": "BR"
    }
  }
}
```

- Installments 1–12 (issuer-dependent up to 18).
- 3DS: add `"authentication": { "type": "threed_secure", "threed_secure": { "mpi": "pagarme" } }`.

#### B.3 Boleto

```json
"payments": [{
  "payment_method": "boleto",
  "boleto": {
    "instructions": "Pagar até a data de vencimento",
    "due_at": "2026-05-21T23:59:59-03:00",
    "document_number": "ORDER-12345",
    "type": "DM"
  }
}]
```

Response → `charges[0].last_transaction.url` (PDF), `.line` (digitable), `.barcode`.

### C. Webhook handling

- **Configuration:** merchant creates the URL in dashboard ("Configurações → Webhooks"). Multiple URLs and per-event filtering supported. An optional **Basic auth user/pass** can be configured per-URL (Pagar.me sends `Authorization: Basic ...` back to us).
- **Signature:** Pagar.me does **not** publish a documented HMAC signature scheme as of v5. The official recommendation is to (a) configure Basic auth on the webhook URL, and (b) on receipt, **re-fetch** the resource (`GET /orders/{id}` or `GET /charges/{id}`) to confirm state. This is what we will do — never trust webhook payload alone.
- **Event types we handle:**
  - `order.paid`, `order.payment_failed`, `order.canceled`
  - `charge.paid`, `charge.refunded`, `charge.payment_failed`, `charge.created`
  - `charge.chargeback_created`, `charge.chargeback_reversed`
- **Retry:** up to 3 retries by default (configurable), exponential backoff; merchant can manually resend via dashboard.

### D. Refund / cancellation

```
DELETE https://api.pagar.me/core/v5/charges/{charge_id}
Authorization: Basic <...>
Idempotency-Key: <uuid>
Content-Type: application/json
```

Body: `{ "amount": 5000 }` (cents) for partial, omit for full. For credit card refunds, Pagar.me reverses to the same card. Time limit: cards ~180 days; Pix ~90 days; boleto can only be cancelled before payment.

### E. Idempotency

Header: `Idempotency-Key: <uuid-v4>`. Pagar.me dedupes for 24 h.

### F. Rate limits

Not publicly documented. Empirically ~200 req/min per account in test, higher in production. HTTP 429 with `Retry-After` header.

### G. Error codes

```json
{ "message": "The request is invalid.", "errors": { "field": ["..."] } }
```

Key gateway responses (`charges[].last_transaction.gateway_response`): `acquirer_return_code` from acquirer (00 = approved, 51 = insufficient funds, 05 = do not honor, 57 = transaction not permitted, etc.).

### H. SDK recommendation

Official: [`@pagarme/pagarme-nodejs-sdk`](https://github.com/pagarme/pagarme-nodejs-sdk) v6.8.10 (June 2024). TypeScript. Last release is ~11 months old as of this writing — actively maintained but slow. **Recommendation: use the SDK for types but consider a thin raw-fetch wrapper with zod schemas** so we don't get blocked by SDK lag when v6 adds fields.

### I. Test data

- Test secret/public keys obtained from dashboard ("Chaves de API → Teste").
- Test cards (any future expiry, any CVV unless noted):

| Number | Behavior |
|---|---|
| 4000 0000 0000 0010 | Approved |
| 4000 0000 0000 0028 | Refused (unauthorized) |
| 4000 0000 0000 0036 | Pending → Paid |
| 4000 0000 0000 0044 | Pending → Failed |
| 4000 0000 0000 0051 | Pending → Canceled |
| 4000 0000 0000 0069 | Paid → Chargeback |
| 4000 0000 0000 0077 | Success → Reversed (cancel scenario) |

- CVV starting with `6` → forces denial.
- `document_number = 11111111111` → forces denial.
- Pix in test returns a real QR code structure; mark paid via dashboard simulator.

---

## 3. PagSeguro / PagBank

Official docs root: <https://dev.pagbank.uol.com.br/reference> (and the newer <https://developer.pagbank.com.br/>)
API base URLs:
- Sandbox: `https://sandbox.api.pagseguro.com`
- Production: `https://api.pagseguro.com`

> **Note:** the `dev.pagbank.uol.com.br` host blocked our automated fetches; the data below was reconstructed from cached references plus the working `developer.pagbank.com.br` mirror. Verify endpoint paths against the live console before going to production.

### A. Authentication credentials

| Credential | Purpose |
|---|---|
| Bearer **token** | Server-to-server (issued per environment in iBanking → Vender Online → Integrações) |
| **Public key** (RSA) | Client-side card encryption via the PagBank checkout SDK |
| Account **token** | Used to validate webhook authenticity (see C) |
| Connect `client_id` / `client_secret` | OAuth (marketplace mode, optional) |

- Header: `Authorization: Bearer <TOKEN>`.
- Sandbox and prod tokens are independent and live at different hosts (see base URLs above). A sandbox token sent to prod (or vice-versa) returns 401.
- **Validation endpoint:** `GET /public-keys/card` returns the current public key for the account; 401 if token invalid.
- **OAuth (Connect):** `POST /oauth2/token` with `grant_type=authorization_code` — only used if payunivercart acts as a marketplace.

### B. Payment creation endpoints

Two parallel models exist; we standardize on **Orders** (newer, single endpoint for all methods):

```
POST https://api.pagseguro.com/orders
Authorization: Bearer <TOKEN>
Content-Type: application/json
x-idempotency-key: <uuid-v4>
```

Common envelope:

```json
{
  "reference_id": "ORDER-12345",
  "customer": {
    "name": "João Silva",
    "email": "buyer@example.com",
    "tax_id": "19119119100",
    "phones": [{ "country": "55", "area": "11", "number": "988887777", "type": "MOBILE" }]
  },
  "items": [
    { "reference_id": "SKU-1", "name": "Produto X", "quantity": 1, "unit_amount": 19990 }
  ],
  "notification_urls": ["https://api.payunivercart.com/webhooks/pagbank/<merchant_id>"]
}
```

Amounts are in **cents** (BRL).

#### B.1 Pix (QR Code)

Omit `charges`, add `qr_codes`:

```json
"qr_codes": [{
  "amount": { "value": 19990 },
  "expiration_date": "2026-05-14T23:59:59-03:00"
}]
```

Response → `qr_codes[0]`:

```json
{
  "id": "QRCO_...",
  "text": "00020101021226...",         // copia-cola
  "links": [
    { "rel": "QRCODE.PNG",  "href": "https://api.pagseguro.com/.../qrcode.png",   "media": "image/png" },
    { "rel": "QRCODE.TEXT", "href": "https://api.pagseguro.com/.../qrcode.text",  "media": "text/plain" }
  ]
}
```

PagBank account must have at least one active Pix key.

#### B.2 Credit card

Card MUST be RSA-encrypted in the browser using the public key + the PagBank checkout SDK (`PagSeguro.encryptCard(...)`). The encrypted blob goes in `card.encrypted`:

```json
"charges": [{
  "reference_id": "CHARGE-1",
  "description": "Pedido #12345",
  "amount": { "value": 19990, "currency": "BRL" },
  "payment_method": {
    "type": "CREDIT_CARD",
    "installments": 3,
    "capture": true,
    "soft_descriptor": "PAYUNIVERCART",
    "card": {
      "encrypted": "<encrypted-blob>",
      "store": false,
      "holder": { "name": "JOAO SILVA", "tax_id": "19119119100" }
    }
  }
}]
```

- Installments 1–12 (issuer-dependent).
- 3DS: include `"authentication_method": { "type": "THREEDS", "id": "<3ds-session-id>" }`.

#### B.3 Boleto

```json
"charges": [{
  "amount": { "value": 19990, "currency": "BRL" },
  "payment_method": {
    "type": "BOLETO",
    "boleto": {
      "due_date": "2026-05-21",
      "instruction_lines": { "line_1": "Pagamento via PagBank", "line_2": "Vencimento em 7 dias" },
      "holder": {
        "name": "JOAO SILVA",
        "tax_id": "19119119100",
        "email": "buyer@example.com",
        "address": {
          "country": "Brasil", "region": "SP", "region_code": "SP", "city": "São Paulo",
          "postal_code": "01310100", "street": "Av. Paulista", "number": "1000", "locality": "Bela Vista"
        }
      }
    }
  }
}]
```

### C. Webhook handling

- **Configuration:** per-request via `notification_urls` array, or globally in the merchant dashboard. We use per-request for tenancy isolation.
- **Signature:** PagBank sends header `x-authenticity-token`. Verification: `SHA-256( <account_token> + "-" + <raw_body> )` (hex). Compare to header. Note: the header is empirically missing in sandbox; treat its absence as a sandbox quirk but **always require it in production**.
- **Event types:** PagBank doesn't send typed events; it POSTs the full updated `order` or `charge` resource. Our handler must inspect `status`:
  - `order.charges[].status`: `AUTHORIZED`, `PAID`, `DECLINED`, `CANCELED`, `IN_ANALYSIS`, `WAITING`
  - For Pix: `qr_codes[].status` and the resulting `charge` with `payment_method.type = "PIX"`
- **Retry:** up to ~10 attempts over 24 h with backoff. Merchant can replay manually from dashboard.

### D. Refund / cancellation

```
POST https://api.pagseguro.com/charges/{charge_id}/cancel
Authorization: Bearer <TOKEN>
x-idempotency-key: <uuid>
Content-Type: application/json
```

Body: `{ "amount": { "value": 5000 } }` (cents) for partial; omit for full. Charge stays `PAID` after partial refund — check `amount.summary.refunded` for the cumulative refunded amount. Time limits: cards ~180 days; Pix ~90 days; boleto not refundable post-payment via API (manual process).

### E. Idempotency

Header: `x-idempotency-key: <uuid-v4>`. Required on `POST /orders` and `POST /charges/{id}/cancel`. Window: 24 h.

### F. Rate limits

Not publicly documented. Empirically ~80 req/s per token. HTTP 429 on burst with `Retry-After`.

### G. Error codes

```json
{
  "error_messages": [
    { "code": "40001", "description": "required_parameter", "parameter_name": "customer.tax_id" }
  ]
}
```

Charge `payment_response`:

```json
{ "code": "20000", "message": "SUCESSO", "reference": "..." }
```

Notable codes: `10000` (acquirer denied), `10001` (issuer denied), `10004` (timeout — **safe to retry once**), `54002` (3DS required).

### H. SDK recommendation

**No official PagBank Node SDK.** All npm packages found (`pagseguro`, `pagseguro-node`, `pagseguro-nodejs`, etc.) are community-maintained, low-traffic, and target legacy v2/v3 APIs — **do not use any of them.**

**Recommendation:** build our own thin client using `undici`/native `fetch` + zod schemas for request/response validation. Card encryption uses the official browser SDK: `https://assets.pagseguro.com.br/checkout-sdk-js/rc/dist/browser/pagseguro.min.js`.

### I. Test data

- Sandbox token from <https://acesso.sandbox.pagseguro.uol.com.br/>.
- Sandbox buyer accounts must be created separately at the sandbox portal.
- Common test cards in sandbox (any future expiry, any CVV unless noted):

| Number | Brand | Behavior |
|---|---|---|
| 4111 1111 1111 1111 | Visa | Approved |
| 5162 3062 5566 4111 | Mastercard | Approved |
| 3793 8146 0827 005 | Amex | Approved |
| Any number with CVV `123` | — | Approved |
| Any number with CVV `999` | — | Denied |

- Pix sandbox: returns a real QR; mark paid using the sandbox simulator endpoint `POST /qr-codes/{id}/pay`.

---

## 4. Stripe

Official docs root: <https://docs.stripe.com/api>
API base URL: `https://api.stripe.com/v1`

### A. Authentication credentials

| Credential | Purpose | Format |
|---|---|---|
| Secret key | Server-to-server | `sk_test_*` / `sk_live_*` |
| Publishable key | Stripe.js / mobile SDKs | `pk_test_*` / `pk_live_*` |
| Restricted key | Scoped server access | `rk_test_*` / `rk_live_*` |
| Webhook signing secret | HMAC verification | `whsec_*` (per endpoint) |

- Header: `Authorization: Bearer <SECRET_KEY>`.
- Environment is determined by key prefix (same host serves both).
- **Validation endpoint:** `GET /v1/balance` — 401 if key invalid.
- Stripe Connect (OAuth) is irrelevant for our model since the merchant brings their own keys.

### B. Payment creation endpoints

Stripe uses a **PaymentIntent** lifecycle. For USD card payments:

```
POST https://api.stripe.com/v1/payment_intents
Authorization: Bearer <SECRET_KEY>
Content-Type: application/x-www-form-urlencoded
Idempotency-Key: <uuid-v4>
```

```json
{
  "amount": 2000,
  "currency": "usd",
  "automatic_payment_methods[enabled]": "true",
  "capture_method": "automatic_async",
  "description": "Order #12345",
  "metadata[order_id]": "ORDER-12345",
  "receipt_email": "buyer@example.com"
}
```

Response (key fields):

```json
{
  "id": "pi_3O...",
  "client_secret": "pi_3O..._secret_xxx",
  "status": "requires_payment_method",
  "next_action": null
}
```

The browser confirms the PaymentIntent via Stripe.js using `client_secret`. Final state arrives via webhook.

#### B.1 Pix (BR)

PaymentIntent with `payment_method_types[]=pix` and `currency=brl`. Requires Pix to be enabled on the Stripe account (Brazilian entity). Limits: R$ 0,50 → R$ 3.000 per tx; one-time only (Pix Automático is invite-only). Several MCC categories are excluded (crypto, insurance, telemedicine, charities). Response includes `next_action.pix_display_qr_code.{data, image_url_png}`.

#### B.2 Credit card

Default. Recommended pattern: `automatic_payment_methods[enabled]=true` lets Stripe pick the method. Installments (`parcelamento`) for BR cards: `payment_method_options[card][installments][enabled]=true`; Stripe returns available plans; we relay to client.

#### B.3 Boleto

`payment_method_types[]=boleto`, `currency=brl`, `payment_method_data[boleto][tax_id]=<CPF>`. Response → `next_action.boleto_display_details.{number, pdf, hosted_voucher_url, expires_at}`.

### C. Webhook handling

- **Configuration:** merchant creates the endpoint in Stripe Dashboard ("Developers → Webhooks → Add endpoint"). Each endpoint has a unique `whsec_*` signing secret.
- **Signature header:** `Stripe-Signature: t=<unix>,v1=<hmac_hex>` (one or more `v1=` entries during key rotation).
- **Verification (HMAC-SHA256):**
  1. extract `t` and `v1` values
  2. signed_payload = `t + "." + raw_body`
  3. expected = `hmac_sha256(whsec, signed_payload).hex()`
  4. constant-time compare to any `v1`
  5. reject if `now - t > 5 min` (Stripe recommends ≤5 min tolerance)
- **Events we handle:**
  - `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled`, `payment_intent.requires_action`
  - `charge.refunded`, `charge.refund.updated`
  - `charge.dispute.created`, `charge.dispute.closed`
- **Retry:** up to **3 days** in production with exponential backoff; sandbox retries within hours. Manual resend from Dashboard within 15 days (30 via CLI).

### D. Refund / cancellation

```
POST https://api.stripe.com/v1/refunds
Authorization: Bearer <SECRET_KEY>
Idempotency-Key: <uuid>
```

Body: `payment_intent=pi_xxx` (full) or `payment_intent=pi_xxx&amount=500` (partial cents). Multiple partials allowed up to original total. No hard time cap (refunds older than 180 days may return as bank credits instead of card reversal).

Cancel un-captured PaymentIntent: `POST /v1/payment_intents/{id}/cancel`.

### E. Idempotency

Header: `Idempotency-Key: <uuid-v4>`. Stripe dedupes for **24 h**. Officially supported on all `POST` endpoints — **use everywhere**.

### F. Rate limits

- Live mode: 100 read + 100 write req/s globally; **25 req/s per endpoint** default.
- Test mode: 25 req/s.
- 429 includes header `Stripe-Rate-Limited-Reason` (`global-rate`, `endpoint-rate`, `global-concurrency`, etc.).
- SDK auto-retries lock-timeout 429s.

### G. Error codes

```json
{ "error": { "type": "card_error", "code": "card_declined", "decline_code": "insufficient_funds", "message": "...", "param": "...", "payment_intent": {...} } }
```

Top-level `type`: `card_error`, `validation_error`, `invalid_request_error`, `api_error`, `rate_limit_error`, `authentication_error`, `idempotency_error`. Retry only on `api_error`, `rate_limit_error`, and network failures. Never retry `card_error` or `invalid_request_error`.

### H. SDK recommendation

Official: [`stripe`](https://github.com/stripe/stripe-node) v22.1.1 (May 2026). TypeScript, ESM + CJS, weekly release cadence. **Use it without hesitation.** Install: `npm install stripe`.

### I. Test data

- Test keys: `sk_test_*`, `pk_test_*`.
- Test cards (any future expiry, any 3-digit CVC):

| Number | Behavior |
|---|---|
| 4242 4242 4242 4242 | Visa, approved |
| 5555 5555 5555 4444 | Mastercard, approved |
| 3782 822463 10005 | Amex, approved (4-digit CVC) |
| 4000 0025 0000 3155 | Visa, requires 3DS challenge |
| 4000 0000 0000 9995 | Insufficient funds |
| 4000 0000 0000 0002 | Generic decline |
| 4000 0000 0000 0069 | Expired card |
| 4000 0000 0000 0127 | Incorrect CVC |

Pix in test mode is fully simulated; use Stripe Dashboard "Pay" button on the test PaymentIntent.

---

## 5. Comparison matrix

| Capability | Mercado Pago | Pagar.me | PagBank | Stripe |
|---|---|---|---|---|
| **Base URL (prod)** | `api.mercadopago.com` | `api.pagar.me/core/v5` | `api.pagseguro.com` | `api.stripe.com/v1` |
| **Sandbox host** | same | same | `sandbox.api.pagseguro.com` | same |
| **Server auth** | Bearer access_token | Basic (sk: + base64) | Bearer token | Bearer secret key |
| **Client tokenization** | MP.js + public_key | Pagar.me.js + public_key | PagSeguro.js + RSA pub key | Stripe.js + pk |
| **Amount unit** | reais (decimal) | **centavos (int)** | **centavos (int)** | **centavos / cents (int)** |
| **Pix** | yes | yes | yes (requires Pix key) | yes (BR account only) |
| **Boleto** | yes | yes | yes | yes |
| **Credit card** | yes | yes | yes | yes |
| **Installments** | 1–12 (up to 18) | 1–12 (up to 18) | 1–12 | 1–12 (BR only) |
| **3DS** | optional/mandatory flag | `authentication.threed_secure` | `authentication_method` | Radar/automatic |
| **Idempotency header** | `X-Idempotency-Key` | `Idempotency-Key` | `x-idempotency-key` | `Idempotency-Key` |
| **Webhook signature** | HMAC-SHA256 (`x-signature`) | none official — refetch | SHA-256(token + "-" + body) | HMAC-SHA256 (`Stripe-Signature`) |
| **Webhook retries** | every 15 min, no cap | up to 3 (configurable) | ~10 attempts / 24 h | exp backoff up to 3 days |
| **Refund endpoint** | `POST /v1/payments/{id}/refunds` | `DELETE /charges/{id}` | `POST /charges/{id}/cancel` | `POST /v1/refunds` |
| **Partial refund** | yes | yes | yes | yes |
| **Refund window (cards)** | ~180 d | ~180 d | ~180 d | unlimited (mode degrades) |
| **Rate limit (docs)** | not published (~250/s) | not published (~200/min test) | not published (~80/s) | **100/s live, 25/s test** |
| **Official Node SDK** | `mercadopago` v2.12 (May 2026) | `@pagarme/pagarme-nodejs-sdk` v6.8.10 (Jun 2024) | **none — build raw** | `stripe` v22.1 (May 2026) |
| **OAuth (marketplace)** | yes (Connect) | no | yes (Connect) | yes (Stripe Connect) |
| **Currency (primary)** | BRL | BRL | BRL | USD / multi |

---

## 6. Adapter-layer recommendations

1. **Common interface.** Define a `PaymentGateway` port (TS interface) with `createPixCharge`, `createCardCharge`, `createBoletoCharge`, `refund`, `getCharge`, `verifyWebhook`. Each gateway becomes an adapter behind it.
2. **Amount normalization.** Internal canonical unit is **cents (bigint)**. Mercado Pago is the only one taking decimals — convert at the adapter boundary.
3. **Idempotency keys.** Generate a deterministic UUIDv5 from `(merchant_id, internal_order_id, attempt)` — same retry produces the same key, but a new internal order is always unique.
4. **Webhook trust model.** Treat every webhook payload as a *hint*. The adapter MUST re-fetch the resource by id and trust only the resulting state. This neutralizes Pagar.me's lack of signature and PagBank's sandbox quirk.
5. **SDK strategy.**
   - Mercado Pago → official SDK.
   - Stripe → official SDK.
   - Pagar.me → official SDK for types + raw `fetch` wrapper with zod for cold paths (the SDK lags).
   - PagBank → raw `fetch` + zod schemas + RSA encryption helper.
6. **Card data never touches our backend.** Tokenization happens in the browser via each gateway's JS SDK. We persist only the resulting token (single-use) or the gateway's `customer_id` + `card_id` if the merchant opts into card-on-file.
7. **Error taxonomy.** Map each gateway's error model into our own canonical enum: `INSUFFICIENT_FUNDS`, `ISSUER_DECLINED`, `FRAUD_SUSPECTED`, `INVALID_CVC`, `EXPIRED_CARD`, `THREE_DS_REQUIRED`, `RATE_LIMITED`, `GATEWAY_TIMEOUT`, `INVALID_REQUEST`, `AUTH_FAILED`. Retry policy is keyed off this enum.
8. **Observability.** Log gateway raw request id (`x-request-id` from MP, `request-id` from Stripe, `correlation_id` from PagBank, `gateway_id` from Pagar.me) in every record — without it, support tickets are unanswerable.

---

## 7. Gaps & open questions

Resolve before shipping the adapter:

1. **PagBank live docs access.** Our research had to use the `developer.pagbank.com.br` mirror because `dev.pagbank.uol.com.br` blocked automated fetches. **Action:** a human engineer must re-verify every PagBank endpoint, field name and error code against the live console before we cut a release. Specifically:
   - confirm exact path for cancel/refund (`/charges/{id}/cancel` vs `/refunds`)
   - confirm whether `x-idempotency-key` is supported (some PagBank endpoints reject unknown headers with 400)
   - confirm whether `x-authenticity-token` is sent in production (community reports say sandbox skips it)
2. **Mercado Pago Orders API.** MP is migrating from the v1 `payments` resource to a new `orders` resource (the "Checkout API via Orders" overview we hit first). Decide whether to integrate against v1 (stable, well-documented) or against `orders` (future-proof but in transition).
3. **3DS flows.** Each gateway exposes 3DS differently. We need a dedicated design doc for the challenge orchestration (browser redirect vs frictionless vs popup).
4. **Webhook IP allowlisting.** None of the four publish a stable IP range. We rely on signature verification + resource refetch.
5. **Pagar.me webhook signing.** Pagar.me v5 has no published HMAC mechanism. Confirm with their support whether one exists in beta we missed.
6. **Stripe Pix in our model.** Stripe Pix only works for a Stripe account incorporated in Brazil. Most merchants on payunivercart will have BR Stripe accounts but we should expose Stripe Pix as a feature flag and surface a clear error when the account is not BR-onboarded.
7. **Marketplace mode.** If payunivercart ever holds funds and pays out to sub-merchants, we need OAuth integrations on MP (Connect) and Stripe Connect — out of scope for v1 but the adapter port should leave room.
