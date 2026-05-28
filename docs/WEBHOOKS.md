# Univercart Webhooks

Server-to-server eventos para integrar Univercart com qualquer stack — CRM,
automação, BI, infra-própria. Modelado em Stripe: envelope estável,
assinatura HMAC, retentativas com backoff, dedupe via `Idempotency-Key`.

---

## 1. Cadastro de endpoint

Painel → **Integrações → Webhooks → Endpoints → Novo endpoint**.

Campos:

- **URL** (`https://` obrigatório — produção rejeita `http`)
- **Eventos** — lista ou wildcard `*`
- **Descrição** (opcional, ajuda auditoria)

No retorno aparece o **secret** uma única vez. Copie e guarde
secretly. Se perder, use **Regenerar secret** — o anterior para de
validar imediatamente.

---

## 2. Anatomia do POST

```
POST /seu/endpoint HTTP/1.1
Host: seuapp.com
Content-Type: application/json
Univercart-Signature: t=1717012345,v1=4f8a9b...
Idempotency-Key: 9f4c1d40-...
User-Agent: Univercart-Webhooks/1.0

{
  "id": "9f4c1d40-...",
  "object": "event",
  "api_version": "2026-05-28",
  "created": 1717012345,
  "type": "order.paid",
  "workspace_id": "8b9a...",
  "livemode": true,
  "data": {
    "object": { "id": "ord_...", "status": "paid", "total_cents": 19900, "..." }
  }
}
```

- **`id`** — UUID único da entrega. Mesmo `id` em retentativas. Use para
  dedupe se sua API for `at-least-once`.
- **`api_version`** — Fixa no momento da emissão. Você pode ramificar
  por versão sem quebrar nas migrações.
- **`livemode: false`** — Evento de teste ou sandbox. Pule efeitos
  colaterais em produção quando vier `false`.
- **`Idempotency-Key`** — Espelha `id`. Garante consistência se o
  receptor processa em fila.

---

## 3. Verificando a assinatura

Header: `Univercart-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>`.

Algoritmo: `HMAC-SHA256(secret, "${t}.${rawBody}")`. **Use o body bytes
exato que chegou no socket — nunca o JSON re-stringificado.**

Janela de replay: 5 minutos. Rejeite se `|now - t| > 300`.

### Node.js

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, rawBody: string, header: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=')),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > 300) return false;

  const expected = createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### Python

```python
import hmac, hashlib, time

def verify(secret: str, raw_body: str, header: str) -> bool:
    parts = dict(p.strip().split('=', 1) for p in header.split(','))
    try:
        t = int(parts['t'])
        v1 = parts['v1']
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > 300:
        return False
    expected = hmac.new(
        secret.encode(), f'{t}.{raw_body}'.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, v1)
```

### PHP

```php
function verify(string $secret, string $rawBody, string $header): bool {
    $parts = [];
    foreach (explode(',', $header) as $p) {
        [$k, $v] = explode('=', trim($p), 2);
        $parts[$k] = $v;
    }
    $t = (int)($parts['t'] ?? 0);
    $v1 = $parts['v1'] ?? '';
    if (!$t || !$v1) return false;
    if (abs(time() - $t) > 300) return false;
    $expected = hash_hmac('sha256', "$t.$rawBody", $secret);
    return hash_equals($expected, $v1);
}
```

### Go

```go
import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "strconv"
    "strings"
    "time"
)

func Verify(secret, rawBody, header string) bool {
    parts := map[string]string{}
    for _, p := range strings.Split(header, ",") {
        kv := strings.SplitN(strings.TrimSpace(p), "=", 2)
        if len(kv) == 2 {
            parts[kv[0]] = kv[1]
        }
    }
    t, err := strconv.ParseInt(parts["t"], 10, 64)
    if err != nil {
        return false
    }
    if abs(time.Now().Unix()-t) > 300 {
        return false
    }
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(strconv.FormatInt(t, 10) + "." + rawBody))
    expected := hex.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(expected), []byte(parts["v1"]))
}

func abs(x int64) int64 { if x < 0 { return -x }; return x }
```

---

## 4. Tipos de evento

Convenção: `<resource>.<verb_or_state>`. Subscreva `order.*` para
receber todo evento de pedido, ou liste apenas os que precisar.

### Pedidos (one-time)

| Evento | Quando |
|---|---|
| `order.created` | Pedido criado no checkout |
| `order.pending_payment` | Aguardando pagamento (PIX/boleto emitido) |
| `order.paid` | Pagamento confirmado pelo gateway |
| `order.cancelled` | Cancelado (falha ou ação manual) |
| `order.expired` | Janela de pagamento expirou |
| `order.refunded` | Estorno total |
| `order.partially_refunded` | Estorno parcial |
| `order.chargedback` | Chargeback do cartão |

### Transações (nível pagamento)

| Evento | Quando |
|---|---|
| `transaction.authorized` | Cartão autorizado, ainda não capturado |
| `transaction.captured` | Captura concluída |
| `transaction.failed` | Falha definitiva |
| `transaction.refunded` | Estorno na transação |
| `transaction.chargeback` | Chargeback aberto |

### Assinaturas (recorrentes)

| Evento | Quando |
|---|---|
| `subscription.created` | Assinatura provisionada |
| `subscription.activated` | Primeira cobrança paga |
| `subscription.renewed` | Renovação paga |
| `subscription.payment_failed` | Falha em renovação |
| `subscription.pending_pix` | Ciclo PIX emitido, aguardando pagamento |
| `subscription.overdue` | Em grace period |
| `subscription.grace_expired` | Grace estourou, cancelamento iminente |
| `subscription.cancelled` | Cancelada |
| `subscription.reactivated` | Pausa → ativa |

### Afiliados

| Evento | Quando |
|---|---|
| `affiliate.commission.created` | Comissão materializada (pending) |
| `affiliate.commission.available` | Janela de reembolso passou |
| `affiliate.commission.reversed` | Estorno reverteu a comissão |
| `affiliate.payout.requested` | Saque solicitado pelo afiliado |
| `affiliate.payout.paid` | Pagamento do saque confirmado |

### Marketplace

| Evento | Quando |
|---|---|
| `marketplace.listing.published` | Listing virou `live` |
| `marketplace.click.recorded` | Click rastreado (volume) |

---

## 5. Política de retentativa

Stripe-style backoff exponencial com jitter:

| Tentativa | Atraso |
|---|---|
| 1 | imediato |
| 2 | ~30s |
| 3 | ~5min |
| 4 | ~30min |
| 5 | ~2h |
| 6 | ~6h |
| 7 | ~12h |
| 8-10 | ~24h cada |

Após **10 falhas** consecutivas a delivery vai para `dead_letter`. O
endpoint **não é pausado** — entregas subsequentes continuam tentando.
Use **Reenviar** no painel para reentregar um dead-letter manualmente.

Resposta esperada do receptor: **HTTP 2xx em ≤30s**. Qualquer outra
coisa (status ≥300, timeout, conexão recusada) conta como falha.

---

## 6. Padrões de implementação

### Ack rápido + processamento async

```ts
app.post('/webhooks/univercart', async (req, res) => {
  const ok = verify(SECRET, req.rawBody, req.headers['univercart-signature']);
  if (!ok) return res.sendStatus(401);

  // Persistir + sumir do hot path. Processamento real em fila.
  await queue.enqueue(req.body);
  res.sendStatus(200);
});
```

### Dedupe por `id`

```ts
const seen = await db.events.findUnique({ where: { id: event.id } });
if (seen) return; // retentativa do mesmo evento
await db.events.create({ data: { id: event.id, type: event.type } });
```

### Filtro por `livemode`

```ts
if (!event.livemode) {
  console.log('test event, skipping fulfilment');
  return;
}
```

---

## 7. Disparo de teste

No painel, em cada endpoint, **Disparar teste** envia um evento com
`livemode: false` e `data.object = { test: true }`. Use para validar
deploys de receptor.

---

## 8. Rotação de secret

`Regenerar secret` invalida o atual imediatamente. Estratégia
zero-downtime:

1. Adicione suporte ao novo secret no receptor (aceitar ambos).
2. Rotacione no painel.
3. Após 5 min (janela de replay), remova o secret antigo.

---

## 9. Segurança

- Use HTTPS sempre.
- Compare HMAC com **timing-safe compare** (`timingSafeEqual` /
  `hmac.compare_digest`).
- Rejeite eventos fora da janela de 5 minutos.
- Trate o secret como senha — nunca commitar, nunca logar.
- Idealmente, mantenha o secret em um KMS / Vault e injete via env.

---

## 10. Suporte

Dúvidas, eventos faltando, bugs em delivery → abra issue em
`github.com/EuKennedy/payunivercart` ou contate o time pelo painel.
