# WAHA (web.js engine) — Technical Reference for PayUniverCart

> **Scope:** Self-hosted WhatsApp HTTP API (WAHA) using the **WEBJS** engine, intended for transactional messaging (OTP, account recovery, payment notifications) on a Brazilian payment facilitator platform.
> **Sources verified:** `waha.devlike.pro/docs/*`, GitHub `devlikeapro/waha` issues #238, #1261, #1974, `pedroslopez/whatsapp-web.js` issues #596, #1967.
> **Last verified:** 2026-05-14.

---

## 0. TL;DR for engineering

- WAHA is a REST wrapper over multiple "engines"; **WEBJS** runs a real headless Chromium with `whatsapp-web.js`. Highest feature parity with WhatsApp Web; heaviest resource footprint (~500MB–1GB RAM per session).
- **Critical Brazil quirk:** WhatsApp internal IDs for **pre-2012 BR mobile numbers** are stored **without the extra "9"** (e.g., `553184956383@c.us`), while post-2012 numbers keep it (`5531984956383@c.us`). **Always** call `GET /api/contacts/check-exists` first and use the returned `chatId` verbatim — never assemble it yourself.
- For OTP / recovery: WEBJS in Core (free) is sufficient. Plus is needed only for multi-session-per-container, S3/Postgres session storage, and advanced reliability features.
- For multi-tenant (each org has its own number): use the multi-session model. **One WAHA Plus container with N sessions** is preferred over N containers for ops/cost; **N independent containers** is preferred for strict isolation/blast-radius if you have <10 tenants.
- Webhooks support HMAC-SHA512 signing, custom retry policies, custom headers, and a per-event `id` field for idempotency.
- Always put WAHA behind nginx with TLS, set `WAHA_API_KEY=sha512:...`, and never expose port 3000 directly.

---

## 1. Engines overview

WAHA exposes a single REST surface implemented by interchangeable "engines". Each engine is a different open-source WhatsApp client library under the hood.

### 1.1 The engines

| Engine | Underlying lib | Transport | Browser required | Resource cost | Feature breadth | Stability |
|---|---|---|---|---|---|---|
| **WEBJS** | `whatsapp-web.js` (pedroslopez) | Puppeteer → real WhatsApp Web in Chromium | Yes | High (≈500MB–1GB RAM/session, 1 vCPU peak) | Highest | Reasonable, but tied to WA Web DOM/JS changes |
| **WPP** | `wppconnect` | Puppeteer → WhatsApp Web | Yes | High | High | Comparable to WEBJS |
| **NOWEB** | `Baileys` (Node.js) | Direct WebSocket to WA servers | No | Low (≈80–150MB/session) | Medium; many features require enabling the local "Store" | Good |
| **GOWS** | `whatsmeow` (Go) | Direct WebSocket | No | Lowest | Medium; positioned as future replacement for NOWEB | Good and improving |
| **VENOM** | `venom-bot` | Puppeteer | Yes | High | Variable | Less actively recommended |

### 1.2 What is WEBJS?

WEBJS launches a real headless Chromium that loads `web.whatsapp.com` and drives the page via Puppeteer + `whatsapp-web.js`. WAHA wraps that with an HTTP/REST surface and a webhook bus.

**Why it works for transactional messaging:**
- Highest feature parity with the WhatsApp Web client (link previews, media types, reactions, presence, mentions, polls, group ops, channels — all stable).
- Best behavior for new/unsaved contacts (the primary OTP use case).
- Best webhook coverage for `message.ack` (delivery/read receipts), which OTP/recovery flows benefit from.
- Behavior closely mirrors the official WhatsApp Web app, reducing the risk of triggering anti-automation heuristics relative to header-spoofed direct-socket engines.

### 1.3 Why NOT NOWEB or GOWS for our use case

- They issue raw WebSocket frames as if a "real" mobile device — historically more risky for unrecognized session fingerprints.
- They have engine-specific gaps that change quarterly (e.g., NOWEB requires `Store` to be enabled for chat/contact lookups; some media flows are reduced).
- For OTP, what matters is: high-trust send + reliable `message.ack`. WEBJS gives that today with the smallest "you got banned because the engine looked suspicious" surface area.

### 1.4 WEBJS limitations (read before shipping)

1. **Brazilian "9-digit" quirk (CRITICAL — see §3).**
2. **Resource heavy.** Chromium per session. Budget ≥1GB RAM and ≥1 vCPU burst per active session. Watch FD/handle leaks under long uptime.
3. **DOM/JS drift.** WhatsApp Web updates can break `whatsapp-web.js` until upstream patches; pin a stable WAHA image tag and test upgrades.
4. **Cold start latency.** STARTING → SCAN_QR_CODE may take 10–30s; STARTING → WORKING after auth is several seconds. Don't expect synchronous "send right now after boot".
5. **Single device per phone.** WhatsApp Multi-Device allows up to 4 linked clients per phone number, **but** running multiple WAHA WEBJS sessions for the *same* number is unsupported and unwise.
6. **Group/channel operations** under WEBJS occasionally throw transient errors; retry with backoff.
7. **Screenshots** of the running Chromium are available (`GET /api/screenshot`) — useful for diagnosing crashes; not available on NOWEB/GOWS.

---

## 2. Session management

### 2.1 Lifecycle states

```
STOPPED → STARTING → SCAN_QR_CODE → WORKING
                       ↓               ↓
                     FAILED ←──────────┘
```

| State | Meaning |
|---|---|
| `STOPPED` | Session exists in config but engine is not running. |
| `STARTING` | Chromium boot, navigating to WhatsApp Web, restoring auth from storage. |
| `SCAN_QR_CODE` | Waiting for user to pair via QR. First QR lives **60s**, then **20s** for each renewal, **max 6 codes**, then session goes `FAILED`. |
| `WORKING` | Authenticated, ready to send/receive. |
| `FAILED` | Auth failed, lost, or engine crashed. Must `restart` or `logout` + start. |

**Recommendation:** subscribe to the `session.status` event globally and treat any non-`WORKING` state as a paging-grade alert for production sessions.

### 2.2 Create a session

```bash
curl -X POST 'https://waha.example.com/api/sessions' \
  -H 'X-Api-Key: ${WAHA_API_KEY}' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "tenant-acme",
    "start": true,
    "config": {
      "debug": false,
      "metadata": {
        "tenant.id": "acme",
        "tenant.plan": "pro"
      },
      "webhooks": [{
        "url": "https://api.payunivercart.com/webhooks/waha",
        "events": ["session.status", "message", "message.any", "message.ack"],
        "hmac": { "key": "${WEBHOOK_HMAC_SECRET}" },
        "retries": { "policy": "exponential", "delaySeconds": 2, "attempts": 8 },
        "customHeaders": [
          { "name": "X-Tenant-Id", "value": "acme" }
        ]
      }],
      "webjs": { "tagsEventsOn": false }
    }
  }'
```

`"start": false` creates the session but does not boot the engine — useful for staged onboarding.

### 2.3 QR authentication

Three retrieval formats:

```bash
# Binary PNG
curl 'https://waha.example.com/api/tenant-acme/auth/qr' \
  -H 'X-Api-Key: ${WAHA_API_KEY}' --output qr.png

# Base64 JSON
curl 'https://waha.example.com/api/tenant-acme/auth/qr' \
  -H 'X-Api-Key: ${WAHA_API_KEY}' \
  -H 'Accept: application/json'

# Raw string (encode in your own QR renderer on the frontend)
curl 'https://waha.example.com/api/tenant-acme/auth/qr?format=raw' \
  -H 'X-Api-Key: ${WAHA_API_KEY}'
```

**Pairing code (fallback for users with broken cameras):**
```bash
curl -X POST 'https://waha.example.com/api/tenant-acme/auth/request-code' \
  -H 'X-Api-Key: ${WAHA_API_KEY}' \
  -H 'Content-Type: application/json' \
  -d '{ "phoneNumber": "5531984956383" }'
```
Returns an 8-char code the user types into WhatsApp → Linked Devices. Official docs warn: "the pairing code is not always available" — always keep QR as the primary path.

### 2.4 Core session operations

| Action | Method | Path |
|---|---|---|
| List sessions | GET | `/api/sessions` |
| Get session details | GET | `/api/sessions/{name}` |
| Update config (PUT) | PUT | `/api/sessions/{name}` |
| Start | POST | `/api/sessions/{name}/start` |
| Stop | POST | `/api/sessions/{name}/stop` |
| Restart | POST | `/api/sessions/{name}/restart` |
| Logout (drops auth, keeps config) | POST | `/api/sessions/{name}/logout` |
| Delete (drops everything) | DELETE | `/api/sessions/{name}` |

**Semantic distinction:** `stop` keeps auth; `logout` clears auth but keeps the session record; `delete` removes everything.

### 2.5 Multi-tenant: 1 instance × N sessions vs. N instances

| Model | Pros | Cons | When to choose |
|---|---|---|---|
| **1 WAHA Plus container, N sessions** | Lower infra cost; shared volume; single Docker host to monitor; supported officially in Plus. | One Chromium crash can briefly affect neighbors; blast radius is the host. | Default for ≥3 tenants. |
| **N independent containers (one per tenant)** | Hard isolation; per-tenant scaling and upgrades; works on Core (free). | N× memory floor; N volumes; more orchestration. | Strict tenancy (e.g., regulated tenants), <10 tenants, or running on Core. |

> **Core (free) limitation:** Core supports **only one WORKING session** per container. To run N tenants on Core, you must run N containers. Plus removes this limit.

### 2.6 Session persistence

- WAHA persists session data (Chromium user-data dir + auth keys) under `/app/.sessions` inside the container. Mount it as a named Docker volume or bind mount with backups.
- WAHA tracks running sessions and **auto-restarts** them after a container restart. Disable with `WAHA_WORKER_RESTART_SESSIONS=False` if you want manual control.
- For Plus: session storage can be moved to **Postgres** (recommended for HA / multi-host). MongoDB is supported but deprecated.

---

## 3. Phone number format — CRITICAL FOR BRAZIL

### 3.1 Format basics

- Numbers are **E.164 without the leading `+`**, all digits only: `5531984956383`.
- ChatIds are suffixed:
  - Individuals: `<digits>@c.us`
  - Groups: `<digits>@g.us`
  - Channels/Newsletters: `<id>@newsletter`
  - Status broadcast: `status@broadcast`
- The newer `@lid` (Linked ID) format is also returned by some endpoints and must be passed through verbatim.

### 3.2 ⚠️ The Brazilian "9 digit" quirk — read this twice

In Brazil, **mobile numbers added a 9 prefix to the subscriber number after 2012** (state by state, finalized nationally in 2016). The WhatsApp internal user ID was assigned at first signup and **was not migrated** for users who registered before the change.

Concretely:

| User registered on WhatsApp | Mobile number today | WhatsApp internal chatId |
|---|---|---|
| **Before 2012** (legacy) | `+55 31 98495-6383` | `553184956383@c.us` *(no extra 9)* |
| **After 2012** | `+55 31 98495-6383` | `5531984956383@c.us` *(with the 9)* |

**You cannot tell which case applies from the phone number alone.** Two users with the same printed mobile number can have different `@c.us` IDs depending on when they signed up for WhatsApp.

**Impact on WEBJS:** If you build the chatId by concatenating digits + `@c.us` and the user is a "pre-2012" account, the message is silently accepted by `whatsapp-web.js` but **never delivered**. Reported in WAHA #238 and `whatsapp-web.js` #596 / #1967.

#### The only correct flow

```bash
# Step 1: ALWAYS resolve the chatId first
curl 'https://waha.example.com/api/contacts/check-exists?phone=5531984956383&session=tenant-acme' \
  -H 'X-Api-Key: ${WAHA_API_KEY}'
```

Response:
```json
{
  "numberExists": true,
  "chatId": "553184956383@c.us"
}
```

Note the `chatId` does **not** match the input — the "9" was stripped because this user is pre-2012.

```bash
# Step 2: Send to the resolved chatId, verbatim
curl -X POST 'https://waha.example.com/api/sendText' \
  -H 'X-Api-Key: ${WAHA_API_KEY}' \
  -H 'Content-Type: application/json' \
  -d '{
    "session": "tenant-acme",
    "chatId": "553184956383@c.us",
    "text": "Seu código PayUniverCart é 482910. Válido por 5 minutos."
  }'
```

**Engineering rules:**
1. Never hand-assemble `<digits>@c.us` for BR mobiles. Resolve and cache.
2. Cache the resolved chatId per (tenant, phone), TTL ~30 days, invalidate on `numberExists=false`.
3. Store both: the user-entered E.164 (for billing/audit) and the resolved chatId (for delivery).
4. Log a metric every time the resolved chatId differs from `<digits>@c.us` — that's your pre-2012 / quirk hit rate, useful for sizing the issue.
5. For non-BR numbers (`country_code != 55` or BR landlines): the resolved chatId typically equals the input — but still resolve once and cache; it's the safest universal pattern.

### 3.3 Non-Brazilian numbers

- US, EU, LATAM (non-BR), APAC: `country_code + national_number`, no leading zeros, no parentheses, no `+`.
- US example: `12025550123@c.us` for +1 (202) 555-0123.
- Practical rule: always call `check-exists` first for any new number, store the returned chatId, send to that. This makes the BR-specific bug disappear from your codepath because the resolver handles all countries uniformly.

---

## 4. Sending messages

All send endpoints accept `session`, `chatId`, and message-type-specific fields. The Swagger spec is the source of truth at runtime: `https://your-waha/swagger`.

### 4.1 Text (OTP-class)

```bash
POST /api/sendText
{
  "session": "tenant-acme",
  "chatId": "553184956383@c.us",
  "text": "Seu código PayUniverCart é *482910*.\nVálido por 5 minutos.",
  "linkPreview": false
}
```

**OTP best practices:**
- `linkPreview: false` — never let WhatsApp re-render an OTP message with a fetched URL.
- Keep the message under ~3 lines. Put the code on its own line, surrounded by zero-width or `*bold*` markers so it's easy to copy.
- Do **not** include a clickable link in the same message as the code (anti-phishing UX + reduces link-bot spam triggers).
- Add a short human-readable expiry ("Válido por 5 minutos") — improves user trust and reduces support tickets.
- Send via the session that matches the *tenant's* WhatsApp number (multi-tenant: route by `tenant_id → session_name`).
- Don't reuse the same OTP code across messages — generate per attempt.
- Rate-limit per destination (`max 3 OTPs / 5 min / chatId`) at the app layer.

### 4.2 Media

```bash
POST /api/sendImage
{
  "session": "tenant-acme",
  "chatId": "553184956383@c.us",
  "file": { "mimetype": "image/jpeg", "url": "https://cdn.payunivercart.com/receipts/xyz.jpg", "filename": "comprovante.jpg" },
  "caption": "Seu comprovante PayUniverCart"
}

POST /api/sendFile
{
  "session": "tenant-acme",
  "chatId": "553184956383@c.us",
  "file": { "mimetype": "application/pdf", "url": "https://cdn.payunivercart.com/invoices/123.pdf", "filename": "fatura-123.pdf" }
}

POST /api/sendVideo
{
  "session": "tenant-acme",
  "chatId": "553184956383@c.us",
  "file": { "mimetype": "video/mp4", "url": "https://cdn.payunivercart.com/v/intro.mp4", "filename": "intro.mp4" },
  "caption": "Bem-vindo",
  "asNote": false,
  "convert": false
}

POST /api/sendVoice
{
  "session": "tenant-acme",
  "chatId": "553184956383@c.us",
  "file": { "mimetype": "audio/ogg; codecs=opus", "url": "https://cdn.payunivercart.com/audio/v.opus" },
  "convert": false
}
```

- `file` accepts either `url` (public, WAHA fetches it) or `data` (base64). Prefer `url` from a CDN with a signed short-lived URL.
- WhatsApp prefers **JPEG** for images, **MP4 (H.264 + AAC)** for video, **OGG/Opus** for voice notes. WAHA Plus exposes `POST /api/{session}/media/convert/{voice|video}` for transcoding.

### 4.3 Buttons / interactive

- Native WhatsApp interactive buttons (and list/CTA messages) are **first-class only in the WhatsApp Cloud / Business API**.
- In WEBJS, **buttons/lists are largely deprecated by WhatsApp** for unofficial clients (Meta disabled them progressively from 2023). WAHA exposes `POST /api/send/buttons` endpoints, but reliability is poor and feature is essentially unusable in 2026. **Do not depend on it.**
- For our OTP/recovery use case, plain text + emoji is the right primitive.

### 4.4 Templates

- WAHA does **not** have a "templates" concept like the Cloud API. There are no pre-approved Meta templates. You send plain messages.
- Implication: there is no Meta template approval process, but also no protection from the "marketing send" anti-spam heuristics — keep transactional intent obvious.

### 4.5 Presence / typing

```bash
POST /api/startTyping  { "session": "tenant-acme", "chatId": "553184956383@c.us" }
POST /api/stopTyping   { "session": "tenant-acme", "chatId": "553184956383@c.us" }
POST /api/sendSeen     { "session": "tenant-acme", "chatId": "553184956383@c.us" }
```

For OTP you can skip the typing indicator. For account recovery flows where a human-feel matters, send `startTyping` for ~1.5s before `sendText`.

### 4.6 Reactions

```bash
POST /api/reaction
{
  "session": "tenant-acme",
  "chatId": "553184956383@c.us",
  "messageId": "false_553184956383@c.us_AAAAA",
  "emoji": "✅"
}
```

Useful for the bot to acknowledge a user's response in recovery flows.

---

## 5. Receiving messages (webhooks)

### 5.1 Configuration

**Per-session** (preferred — survives env changes, routes per tenant): set in the session `config.webhooks[]` (see §2.2).

**Global** (env-level, applies to all sessions):
```
WHATSAPP_HOOK_URL=https://api.payunivercart.com/webhooks/waha
WHATSAPP_HOOK_EVENTS=session.status,message,message.any,message.ack
WHATSAPP_HOOK_HMAC_KEY=<secret>
WHATSAPP_HOOK_RETRIES_POLICY=exponential
WHATSAPP_HOOK_RETRIES_DELAY_SECONDS=2
WHATSAPP_HOOK_RETRIES_ATTEMPTS=8
WHATSAPP_HOOK_CUSTOM_HEADERS=X-Source:waha;X-Env:prod
```

### 5.2 Event types we care about

| Event | When | Why for us |
|---|---|---|
| `session.status` | STARTING → SCAN_QR_CODE → WORKING → FAILED transitions | Paging signal; auto-recover. |
| `message` | Incoming message from a user | Recovery flow user replies. |
| `message.any` | All messages including ones **we** sent (`source: "api"` or `"app"`) | Audit trail / dedup. |
| `message.ack` | Delivery state changes: ERROR, PENDING, SERVER, DEVICE, READ, PLAYED | OTP delivery confirmation; SLA metrics. |
| `message.reaction` | Reaction added/removed | Recovery confirmation flow. |
| `message.edited`, `message.revoked` | Edit/delete | Audit / compliance. |
| `presence.update` | Online/offline/typing of a contact | Mostly noisy — skip in prod. |
| `engine.event` | Low-level engine internals | Debug only. |

### 5.3 Payload envelope

Every webhook is the same envelope:

```json
{
  "id": "evt_01HZ5Q8X3V8RZ7T1KX5J2WQ7N9",
  "timestamp": 1741249702485,
  "event": "message",
  "session": "tenant-acme",
  "metadata": { "tenant.id": "acme", "tenant.plan": "pro" },
  "me": { "id": "5531999990000@c.us", "pushName": "PayUniverCart" },
  "payload": { /* event-specific */ },
  "environment": { "tier": "PLUS", "version": "2026.4.1" },
  "engine": "WEBJS"
}
```

#### Example: `message.ack` payload
```json
{
  "id": "false_553184956383@c.us_3EB0...",
  "from": "5531999990000@c.us",
  "to": "553184956383@c.us",
  "ack": 3,
  "ackName": "READ"
}
```
`ack` semantics: `-1=ERROR, 0=PENDING, 1=SERVER, 2=DEVICE, 3=READ, 4=PLAYED`.

### 5.4 Security: HMAC verification

WAHA signs the **raw request body** with `HMAC-SHA512` using `config.hmac.key` and sends:

| Header | Content |
|---|---|
| `X-Webhook-Hmac` | hex(HMAC-SHA512(secret, raw_body)) |
| `X-Webhook-Hmac-Algorithm` | `sha512` |
| `X-Webhook-Request-Id` | UUID for the delivery attempt |
| `X-Webhook-Timestamp` | Unix ms |
| Custom headers | from `customHeaders` |

**Verification (Node.js):**
```ts
import crypto from "node:crypto";

function verifyWahaSignature(rawBody: Buffer, headerHmac: string, secret: string) {
  const computed = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(headerHmac));
}
```

Always verify **before** parsing JSON, on the raw bytes. Reject (return 401) if mismatched.

### 5.5 Retry policy

Set in session config. Three policies:

| Policy | Schedule (delaySeconds=2) |
|---|---|
| `constant` | 2, 2, 2, 2, … |
| `linear` | 2, 4, 6, 8, … |
| `exponential` | 2, 4.1, 8.4, 16.3, … (with jitter) |

Recommended for prod: `exponential, delaySeconds=2, attempts=8` (≈8–10 min of retries total).

**Webhook contract for our endpoint:**
- Return **2xx within 5 seconds** to ack. Anything else triggers retry.
- For long work, ack synchronously and enqueue async (e.g., to SQS/Redis).
- Be ready for duplicates — see idempotency below.

### 5.6 Idempotency

- The envelope `id` (`evt_…`) is **stable across retries** of the same delivery — use it as the dedup key in a 24h Redis SET or DB unique index.
- Additionally, the message-payload `id` (`false_<chatId>_<random>`) is stable per WhatsApp message — use it to dedup business-level effects.
- Don't dedup by `timestamp` alone.

### 5.7 Alternative: WebSocket streaming

For low-latency consumption you can subscribe to events over WS:
```
ws://waha:3000/ws?session=*&events=message,message.ack&x-api-key=...
```
Useful for an internal monitoring dashboard. For business webhooks, prefer HTTP — it has built-in retries.

---

## 6. Self-hosting on Docker

### 6.1 Images

| Image | Notes |
|---|---|
| `devlikeapro/waha` | **Core** (free). Single working session. |
| `devlikeapro/waha-plus` | **Plus** (paid). Multi-session, Postgres/S3 storage, advanced retries, debug mode. |

Tags follow `{image}:{browser}[-cpu][-version]`. Use the **Chromium variant** for WEBJS. Pin a version tag in production (not `latest`).

### 6.2 docker-compose (production baseline, single tenant)

```yaml
services:
  waha:
    image: devlikeapro/waha:chrome-2026.4.1
    container_name: waha
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # bind to localhost; nginx terminates TLS
    environment:
      # --- security ---
      WAHA_API_KEY: "sha512:${WAHA_API_KEY_SHA512}"
      WAHA_API_KEY_EXCLUDE_PATH: "health,ping"
      WAHA_DASHBOARD_ENABLED: "true"
      WAHA_DASHBOARD_USERNAME: "${WAHA_DASH_USER}"
      WAHA_DASHBOARD_PASSWORD: "${WAHA_DASH_PASS}"
      WHATSAPP_SWAGGER_ENABLED: "false"     # disable in prod
      # --- engine ---
      WHATSAPP_DEFAULT_ENGINE: "WEBJS"
      WAHA_WORKER_RESTART_SESSIONS: "True"
      # --- webhooks (global fallback) ---
      WHATSAPP_HOOK_URL: "https://api.payunivercart.com/webhooks/waha"
      WHATSAPP_HOOK_EVENTS: "session.status,message,message.any,message.ack"
      WHATSAPP_HOOK_HMAC_KEY: "${WAHA_HOOK_HMAC}"
      WHATSAPP_HOOK_RETRIES_POLICY: "exponential"
      WHATSAPP_HOOK_RETRIES_DELAY_SECONDS: "2"
      WHATSAPP_HOOK_RETRIES_ATTEMPTS: "8"
      # --- logging / health ---
      WAHA_LOG_FORMAT: "JSON"
      WAHA_LOG_LEVEL: "info"
    volumes:
      - waha_sessions:/app/.sessions
      - waha_media:/app/.media
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:3000/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:    { cpus: "2.0", memory: "2g" }
        reservations: { cpus: "0.5", memory: "1g" }

volumes:
  waha_sessions:
  waha_media:
```

### 6.3 Required env vars

| Variable | Purpose |
|---|---|
| `WAHA_API_KEY` | API protection. Prefer `sha512:<hex>` format. |
| `WHATSAPP_DEFAULT_ENGINE` | `WEBJS` for us. |
| `WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS`, `WHATSAPP_HOOK_HMAC_KEY` | Global webhook. |
| `WAHA_DASHBOARD_USERNAME`, `WAHA_DASHBOARD_PASSWORD` | Dashboard basic auth. |
| `WAHA_LOG_FORMAT=JSON`, `WAHA_LOG_LEVEL=info` | Structured logs for ELK/Loki. |
| `WHATSAPP_SWAGGER_ENABLED=false` | Disable Swagger in prod. |
| `WAHA_API_KEY_EXCLUDE_PATH=health,ping` | Let load balancer probe without a key. |
| `WHATSAPP_HEALTH_*_THRESHOLD_MB` | Disk-space health thresholds (Plus). |

### 6.4 Volumes

| Path | What | Backup? |
|---|---|---|
| `/app/.sessions` | Chromium user-data dirs + WA auth keys | **Yes, encrypted**. Loss = re-scan QR for every tenant. |
| `/app/.media` | Cached media | Optional. |

### 6.5 Resource sizing (WEBJS)

| Sessions per host | RAM | vCPU | Disk |
|---|---|---|---|
| 1 | 1.5 GB | 1 | 10 GB |
| 5 (Plus) | 6 GB | 4 | 30 GB |
| 10 (Plus) | 12 GB | 6 | 60 GB |
| 20+ (Plus) | split across hosts | — | — |

Chromium leaks slowly; plan a weekly rolling restart (cordon-style: stop sessions one at a time, restart, resume).

### 6.6 Coolify deployment notes

1. Create an **Application → Docker Compose** service with the YAML above.
2. Configure the persistent volumes `waha_sessions` and `waha_media` in Coolify's storage panel — never as anonymous volumes.
3. Set the Coolify domain → expose only port 443; let Coolify's reverse proxy handle TLS (it uses Traefik/Caddy). WAHA stays on `127.0.0.1:3000`.
4. Put all env vars (API key, HMAC, dashboard creds) in Coolify's **Secrets**, not in the compose file.
5. Set Coolify health check to `/ping` returning 200.
6. Enable Coolify's **automatic backups** for the `waha_sessions` volume daily.
7. For multi-tenant: deploy **one Coolify "service" per WAHA Plus instance**, with N sessions inside.

### 6.7 Multi-tenant deployment recommendation

For PayUniverCart (B2B SaaS, each merchant org has its own WhatsApp number):

- **Phase 1 (≤20 tenants):** 1 WAHA Plus container per region (BR-southeast), N sessions inside. Routing: tenant_id → session_name (`tenant-${slug}`).
- **Phase 2 (>20 tenants):** Shard by tenant_id hash across 2–4 WAHA Plus containers. Use a small router service that maps tenant → WAHA hostname.
- Don't try to share a single WhatsApp number across tenants. One number per tenant. That's the WhatsApp model, fighting it ends in bans.

---

## 7. API authentication & TLS

### 7.1 API key

Generate:
```bash
KEY=$(uuidgen | tr -d '-')
HASH=$(echo -n "$KEY" | shasum -a 512 | awk '{print $1}')
echo "PLAIN: $KEY"
echo "WAHA_API_KEY=sha512:$HASH"
```

Set `WAHA_API_KEY=sha512:<hash>` in env. Send `$KEY` in `X-Api-Key` header from your backend. **Never** expose the plain key to the browser. If a public asset must include it, use **session-scoped keys** (see §7.3).

### 7.2 nginx reverse proxy (TLS termination)

```nginx
server {
  listen 443 ssl http2;
  server_name waha.payunivercart.com;

  ssl_certificate     /etc/letsencrypt/live/waha.payunivercart.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/waha.payunivercart.com/privkey.pem;

  # Allow only our backend egress IPs
  allow 10.0.0.0/16;
  deny  all;

  client_max_body_size 50m;   # media uploads

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }

  location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
}
```

### 7.3 Session-scoped (limited) API keys

For per-tenant access to a single session — e.g., a tenant dashboard that pulls its own messages:

```json
{
  "isAdmin": false,
  "session": "tenant-acme",
  "isActive": true,
  "actions": { "read": true, "send": false, "control": false }
}
```
Scopes: `read`, `send`, `control`, `setting`, `app`, `delete`. Always start with the minimum.

---

## 8. Rate limits, stability, reconnection

### 8.1 WhatsApp-side limits (not WAHA, but we live by them)

- WhatsApp doesn't publish hard numbers for unofficial clients. Empirical safe band for OTP traffic on a "warmed" number (>30 days old, multiple human chats already): ~30–60 messages/min sustained, bursts to ~120/min.
- New numbers: warm up — start with <100/day, ramp over 2 weeks.
- Same-text floods across many recipients (the OTP shape!) are the **most** likely to trigger pattern-detection. Randomize the message slightly: vary line breaks, swap `*bold*` placement, randomize emoji.
- Use one number per tenant. Don't blast 10k OTPs from one number.

### 8.2 Stability quirks of WEBJS

- Chromium can OOM under load; set `--max-old-space-size` via `WAHA_NODE_OPTIONS` if needed; keep RAM headroom.
- WhatsApp Web updates occasionally break selectors; pin WAHA image tag, test before upgrade.
- Long-uptime sessions can drift into a "ghost" state where `state` says WORKING but sends silently fail. Mitigation:
  - Watch `message.ack` — if no `SERVER` ack arrives within 30s of send, escalate.
  - Health-check by sending a `sendSeen` to your own number every 15 min; alert on failure.
  - Restart sessions weekly (off-peak).

### 8.3 Reconnection strategy

```
on session.status FAILED:
  1. POST /api/sessions/{name}/restart
  2. wait up to 60s for state == WORKING
  3. if still not WORKING:
       page on-call,
       POST /api/sessions/{name}/logout
       POST /api/sessions/{name}/start
       surface QR to tenant admin UI for re-pairing
```

Auto-restart works for engine crashes; **QR re-pairing** is required when the user manually unlinks from their phone or WhatsApp invalidates the link.

### 8.4 Send-side retries

- Treat `POST /api/sendText` as **at-least-once**. If we get a network error mid-flight, the message *may* have been sent. Always include a client-side idempotency key in your DB before calling WAHA; on retry, first check `message.any` webhooks for a matching outbound `id`.
- Backoff: 1s, 3s, 10s, 30s, then dead-letter to ops queue.

---

## 9. Pricing / licensing

### 9.1 Core (free, open source)

- All engines.
- **One** authenticated session per container (a hard limit).
- Local file session storage only.
- HTTP webhooks with HMAC, custom headers, retries.
- All send/receive message types relevant to us.
- **Sufficient for PayUniverCart OTP + recovery** if we accept "1 container per tenant" architecture.

### 9.2 Plus (paid — Patreon / Boosty)

Adds:
- **Multiple sessions** in a single container.
- **Postgres / MongoDB** session storage (HA-friendly).
- **S3** media storage.
- `/health` deep checks (disk, store, DB).
- Debug endpoints (`/api/server/debug/cpu|heapsnapshot|browser/trace`).
- Voice/video conversion endpoints.
- Priority bug-fix and Discord support.
- Team seats on the PRO tier (up to 5).

### 9.3 Recommendation for PayUniverCart

- **MVP / pilot (≤5 tenants):** Core, 1 container per tenant, file-based session storage. Cost: $0 in licensing.
- **Growth (>5 tenants):** Upgrade to Plus, consolidate to N sessions per container, move session state to Postgres for HA. The license cost is small compared to the ops simplification.

Pricing isn't on the public docs page — it's listed at `waha.devlike.pro/support-us` and is per-month Patreon-style tiers. Budget accordingly.

---

## 10. API endpoints summary (cheatsheet)

> All requests require `X-Api-Key: <key>` and `Content-Type: application/json` for POST.

### Sessions
```
GET    /api/sessions
POST   /api/sessions
GET    /api/sessions/{name}
PUT    /api/sessions/{name}
DELETE /api/sessions/{name}
POST   /api/sessions/{name}/start
POST   /api/sessions/{name}/stop
POST   /api/sessions/{name}/restart
POST   /api/sessions/{name}/logout
```

### Auth
```
GET    /api/{session}/auth/qr            # ?format=raw or Accept: application/json
POST   /api/{session}/auth/request-code  # { "phoneNumber": "..." }
```

### Contacts
```
GET    /api/contacts/check-exists?phone={digits}&session={name}
GET    /api/contacts?contactId={id}&session={name}
GET    /api/contacts/profile-picture?contactId={id}&session={name}[&refresh=true]
```

### Send
```
POST   /api/sendText            { session, chatId, text, linkPreview?, reply_to?, mentions? }
POST   /api/sendImage           { session, chatId, file{mimetype,url|data,filename}, caption? }
POST   /api/sendVideo           { session, chatId, file, caption?, asNote?, convert? }
POST   /api/sendVoice           { session, chatId, file, convert? }
POST   /api/sendFile            { session, chatId, file, caption? }
POST   /api/sendLocation        { session, chatId, latitude, longitude, title?, address? }
POST   /api/sendContactVcard    { session, chatId, contact }
POST   /api/reaction            { session, chatId, messageId, emoji }
POST   /api/sendSeen            { session, chatId }
POST   /api/startTyping         { session, chatId }
POST   /api/stopTyping          { session, chatId }
```

### Media conversion (Plus)
```
POST   /api/{session}/media/convert/voice   { url|data }
POST   /api/{session}/media/convert/video   { url|data }
```

### Observability
```
GET    /ping                            -> { "message": "pong" }
GET    /health                          -> 200 healthy / 503 unhealthy (Plus)
GET    /api/server/status               -> uptime, started_at
GET    /api/server/version              -> engine, browser, version
GET    /api/server/debug/cpu?seconds=30 -> CPU profile (Plus, WAHA_DEBUG_MODE)
GET    /api/server/debug/heapsnapshot   -> heap snapshot (Plus)
GET    /api/server/debug/browser/trace/{session}?seconds=30 -> Chromium trace (Plus, WEBJS)
```

### Webhook headers (delivered to **our** endpoint)
```
X-Webhook-Hmac:            <sha512 hex of raw body>
X-Webhook-Hmac-Algorithm:  sha512
X-Webhook-Request-Id:      <uuid>
X-Webhook-Timestamp:       <unix ms>
+ any customHeaders configured
```

### WebSocket
```
ws://waha/ws?session={name|*}&events={list|*}&x-api-key={key}
```

---

## Appendix A — End-to-end OTP send (pseudocode)

```ts
async function sendOtp(tenantId: string, e164Phone: string, code: string) {
  const sessionName = `tenant-${tenantId}`;
  const phoneDigits = e164Phone.replace(/\D/g, "");

  // 1. Resolve chatId (handles BR 9-digit quirk + caching).
  let chatId = await cache.get(`waha:chatid:${tenantId}:${phoneDigits}`);
  if (!chatId) {
    const r = await waha.get(`/api/contacts/check-exists`, {
      params: { phone: phoneDigits, session: sessionName }
    });
    if (!r.data.numberExists) throw new Error("NOT_ON_WHATSAPP");
    chatId = r.data.chatId;
    await cache.set(`waha:chatid:${tenantId}:${phoneDigits}`, chatId, "30d");
  }

  // 2. Build idempotency key BEFORE the call.
  const idemKey = `otp:${tenantId}:${phoneDigits}:${code}`;
  await db.outbox.insertIfAbsent({ idemKey, chatId, status: "PENDING" });

  // 3. Send.
  const resp = await waha.post(`/api/sendText`, {
    session: sessionName,
    chatId,
    text: `Seu código PayUniverCart é *${code}*.\nVálido por 5 minutos.`,
    linkPreview: false
  }, { headers: { "X-Idempotency-Key": idemKey } });

  // 4. Persist the WhatsApp message id for ack correlation.
  await db.outbox.update(idemKey, { waMsgId: resp.data.id, status: "SENT" });
  return resp.data.id;
}
```

## Appendix B — Webhook handler skeleton (Node.js / Fastify)

```ts
fastify.post("/webhooks/waha", { config: { rawBody: true } }, async (req, reply) => {
  const sig = req.headers["x-webhook-hmac"] as string;
  if (!verifyWahaSignature(req.rawBody as Buffer, sig, process.env.WEBHOOK_HMAC_SECRET!)) {
    return reply.code(401).send();
  }
  const evt = JSON.parse((req.rawBody as Buffer).toString("utf8"));

  // Idempotency on envelope id.
  if (await dedupe.seen(`waha:evt:${evt.id}`)) return reply.code(200).send();

  // Ack immediately, process async.
  await queue.enqueue("waha-events", evt);
  return reply.code(200).send();
});
```

## Appendix C — Operational alerts (suggested)

| Signal | Threshold | Severity |
|---|---|---|
| `session.status != WORKING` for any tenant | >2 min | page |
| `message.ack ERROR` rate per session | >5% in 5 min | page |
| No outbound `SERVER` ack within 30s | any | warn |
| Webhook 5xx rate (our endpoint) | >1% in 5 min | page |
| WAHA `/ping` failure | 3 consecutive | page |
| Disk usage on `waha_sessions` volume | >80% | warn |
| WAHA container RSS | >80% of limit | warn |

---

**Document end. Verify against live Swagger (`/swagger`) before shipping — engine behavior and payloads do drift with WAHA releases.**
