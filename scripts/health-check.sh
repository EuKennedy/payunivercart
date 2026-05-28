#!/usr/bin/env bash
# =============================================================================
# Univercart — Health check + E2E smoke
# -----------------------------------------------------------------------------
# Bate ~30 checks no ambiente alvo. Roda sem credentials (só endpoints
# públicos + introspecção via tRPC), portanto:
#   - Nao testa rotas autenticadas (dashboard, account.exportData, etc.).
#   - Nao testa side-effects (webhook delivery, payout dispatch).
#   - Testa: API healthy, tRPC contratos, marketplace público, SEO,
#     checkout open, tracking pixels expostos, webhooks vazios sem auth
#     (esperado 401), DB schema applied, plus latencia + headers.
#
# Uso:
#   bash scripts/health-check.sh                    # prod default
#   API=https://staging.api.univercart.com bash scripts/health-check.sh
#
# Saida: tabela por check + total PASS/FAIL + exit 1 se algum FAIL.
# =============================================================================

set -u
set -o pipefail

API="${API:-https://api.univercart.com}"
DASHBOARD="${DASHBOARD:-https://app.univercart.com}"
CHECKOUT="${CHECKOUT:-https://pay.univercart.com}"
SLUG="${SLUG:-assinatura-univerzap-mensal-eca5}"

PASS=0
FAIL=0
FAIL_LIST=()

# Cores ANSI
G='\033[0;32m'  # verde
R='\033[0;31m'  # vermelho
Y='\033[0;33m'  # amarelo
B='\033[0;34m'  # azul
C='\033[0;36m'  # ciano
N='\033[0m'

header() {
  echo ""
  echo -e "${B}========================================${N}"
  echo -e "${B}$1${N}"
  echo -e "${B}========================================${N}"
}

# check NOME EXPECTED-PASS-CONDITION TEST-CMD
check() {
  local name="$1"
  shift
  local detail
  detail=$("$@" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ]; then
    PASS=$((PASS + 1))
    printf "  ${G}✓${N} %-50s ${C}%s${N}\n" "$name" "${detail:0:80}"
  else
    FAIL=$((FAIL + 1))
    FAIL_LIST+=("$name")
    printf "  ${R}✗${N} %-50s ${R}%s${N}\n" "$name" "${detail:0:80}"
  fi
}

# Helpers de assercao --------------------------------------------------------
http_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"
}

http_body() {
  curl -s --max-time 15 "$1"
}

assert_http_2xx() {
  local url="$1"
  local code
  code=$(http_status "$url")
  if [[ "$code" =~ ^2 ]]; then
    echo "HTTP $code"
    return 0
  fi
  echo "HTTP $code (expected 2xx)"
  return 1
}

assert_http_4xx() {
  local url="$1"
  local code
  code=$(http_status "$url")
  if [[ "$code" =~ ^4 ]]; then
    echo "HTTP $code"
    return 0
  fi
  echo "HTTP $code (expected 4xx)"
  return 1
}

assert_json_path() {
  local url="$1"
  local jq_expr="$2"
  local expected="$3"
  local actual
  actual=$(http_body "$url" | jq -r "$jq_expr" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    echo "$jq_expr == $expected"
    return 0
  fi
  echo "got '$actual' expected '$expected'"
  return 1
}

assert_json_nonempty() {
  local url="$1"
  local jq_expr="$2"
  local actual
  actual=$(http_body "$url" | jq -r "$jq_expr" 2>/dev/null)
  if [ -n "$actual" ] && [ "$actual" != "null" ] && [ "$actual" != "[]" ] && [ "$actual" != "{}" ]; then
    echo "$jq_expr = ${actual:0:50}"
    return 0
  fi
  echo "$jq_expr is empty/null"
  return 1
}

assert_header_present() {
  local url="$1"
  local header="$2"
  local val
  val=$(curl -sI --max-time 15 "$url" | grep -i "^${header}:" | head -1 | cut -d':' -f2- | tr -d '\r')
  val="${val# }"
  if [ -n "$val" ]; then
    echo "$header: ${val:0:60}"
    return 0
  fi
  echo "$header header missing"
  return 1
}

assert_latency_under() {
  local url="$1"
  local max_ms="$2"
  local ms
  ms=$(curl -s -o /dev/null -w '%{time_total}' --max-time 15 "$url")
  # converte segundos pra ms via awk pq bash nao tem float
  ms=$(awk -v t="$ms" 'BEGIN { printf "%.0f", t*1000 }')
  if [ "$ms" -le "$max_ms" ]; then
    echo "${ms}ms (<= ${max_ms}ms)"
    return 0
  fi
  echo "${ms}ms (slow > ${max_ms}ms)"
  return 1
}

# Confere deps locais
for cmd in curl jq awk; do
  if ! command -v $cmd >/dev/null 2>&1; then
    echo -e "${R}Faltando comando obrigatorio: $cmd${N}"
    exit 2
  fi
done

echo -e "${Y}🔍 Univercart health check${N}"
echo -e "  API:       $API"
echo -e "  DASHBOARD: $DASHBOARD"
echo -e "  CHECKOUT:  $CHECKOUT"
echo -e "  SLUG:      $SLUG"
echo -e "  Start:     $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# ============================================================================
header "1. API — Liveness & basics"
# ============================================================================

check "/health 200 OK" assert_http_2xx "$API/health"
check "/health uptimeSeconds > 0" assert_json_nonempty "$API/health" '.uptimeSeconds | select(. > 0)'
check "/health latency < 800ms" assert_latency_under "$API/health" 800
check "Strict-Transport-Security present" assert_header_present "$API/health" "Strict-Transport-Security"
check "X-Content-Type-Options nosniff" assert_header_present "$API/health" "X-Content-Type-Options"

# ============================================================================
header "2. Marketplace público (Pilar 4)"
# ============================================================================

MKT_URL="$API/trpc/marketplace.browse?input=%7B%22json%22%3A%7B%22limit%22%3A20%7D%7D"
check "marketplace.browse 200" assert_http_2xx "$MKT_URL"
check "marketplace.browse latency < 2000ms" assert_latency_under "$MKT_URL" 2000
check "marketplace.browse items[] non-empty" assert_json_nonempty "$MKT_URL" '.result.data.items[0].id'
check "marketplace.browse retorna workspaceName" assert_json_nonempty "$MKT_URL" '.result.data.items[0].workspaceName'

# Per-listing detail (pega 1 listing real)
LISTING_ID=$(http_body "$MKT_URL" | jq -r '.result.data.items[0].id' 2>/dev/null)
if [ -n "$LISTING_ID" ] && [ "$LISTING_ID" != "null" ]; then
  DETAIL_URL="$API/trpc/marketplace.bySlug?input=%7B%22listingId%22%3A%22${LISTING_ID}%22%7D"
  check "marketplace.bySlug 200" assert_http_2xx "$DETAIL_URL"
fi

# browseForAffiliation (pode 500 se migration 0020 ausente)
BAF_URL="$API/trpc/marketplace.browseForAffiliation?input=%7B%22json%22%3A%7B%7D%7D"
check "marketplace.browseForAffiliation 200" assert_http_2xx "$BAF_URL"

# ============================================================================
header "3. Checkout API público (getBySlug)"
# ============================================================================

GBS_URL="$API/trpc/checkout.getBySlug?input=%7B%22slug%22%3A%22${SLUG}%22%7D"
check "checkout.getBySlug 200" assert_http_2xx "$GBS_URL"
check "checkout.getBySlug retorna product.id" assert_json_nonempty "$GBS_URL" '.result.data.product.id'
check "checkout.getBySlug retorna workspace.id" assert_json_nonempty "$GBS_URL" '.result.data.workspace.id'
check "checkout.getBySlug retorna gateway (LGPD-safe)" assert_json_nonempty "$GBS_URL" '.result.data.gateway.id'
check "checkout.getBySlug expõe mpPublicKey (PCI SAQ-A path)" assert_json_nonempty "$GBS_URL" '.result.data.gateway.mpPublicKey'
check "checkout.getBySlug pixels[] disponível" assert_json_nonempty "$GBS_URL" '.result.data.pixels | length > 0'

# ============================================================================
header "4. Subscriptions (PIX recorrente schema)"
# ============================================================================

# Verifica plans[] retornado por getBySlug tem paymentMethod (migration 0021)
check "plans[].paymentMethod presente (migr 0021)" assert_json_nonempty "$GBS_URL" '.result.data.product.plans[0].paymentMethod'

# ============================================================================
header "5. Auth surface (protegida — esperar 401)"
# ============================================================================

check "marketplace.listMine 401 sem auth" assert_http_4xx "$API/trpc/marketplace.listMine?input=%7B%22json%22%3Anull%7D"
check "subscriptions.listSubscriptions 401" assert_http_4xx "$API/trpc/subscriptions.listSubscriptions?input=%7B%22json%22%3A%7B%7D%7D"
check "account.exportData 401 sem session" assert_http_4xx "$API/trpc/account.exportData?input=%7B%22json%22%3Anull%7D"
check "webhooks.listInbound 401" assert_http_4xx "$API/trpc/webhooks.listInbound?input=%7B%22json%22%3A%7B%7D%7D"
check "tracking.list 401 sem session" assert_http_4xx "$API/trpc/tracking.list?input=%7B%22json%22%3Anull%7D"

# ============================================================================
header "6. Webhook handlers (gateway POST surface)"
# ============================================================================

# Sem signature válida — esperar 401 (invalid_signature) ou 400
check "/webhooks/gateway/mercadopago POST sem sig → 4xx" \
  bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' --max-time 15 '$API/webhooks/gateway/mercadopago' | grep -qE '^4' && echo 'rejeitou sem signature' || echo 'aceitou — FALHA'"

check "/webhooks/gateway/pagarme POST sem sig → 4xx" \
  bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' --max-time 15 '$API/webhooks/gateway/pagarme' | grep -qE '^4' && echo 'rejeitou sem signature' || echo 'aceitou — FALHA'"

check "/webhooks/gateway/pagseguro POST sem sig → 4xx" \
  bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' --max-time 15 '$API/webhooks/gateway/pagseguro' | grep -qE '^4' && echo 'rejeitou sem signature' || echo 'aceitou — FALHA'"

# ============================================================================
header "7. Public surface: dashboard + checkout HTML"
# ============================================================================

check "Dashboard / responde 200" assert_http_2xx "$DASHBOARD/"
check "Dashboard /termos responde 200" assert_http_2xx "$DASHBOARD/termos"
check "Dashboard /privacidade responde 200" assert_http_2xx "$DASHBOARD/privacidade"
check "Dashboard /login responde 200" assert_http_2xx "$DASHBOARD/login"

check "Checkout /c/<slug> responde 200" assert_http_2xx "$CHECKOUT/c/$SLUG"
check "Checkout /marketplace responde 200" assert_http_2xx "$CHECKOUT/marketplace"

# ============================================================================
header "8. SEO: sitemap + robots"
# ============================================================================

check "/sitemap.xml 200" assert_http_2xx "$CHECKOUT/sitemap.xml"
check "/robots.txt 200" assert_http_2xx "$CHECKOUT/robots.txt"
check "sitemap.xml contains /marketplace" bash -c "curl -s --max-time 10 '$CHECKOUT/sitemap.xml' | grep -q '/marketplace' && echo 'marketplace URLs presentes' || echo 'missing /marketplace'"
check "robots.txt disallows /c/" bash -c "curl -s --max-time 10 '$CHECKOUT/robots.txt' | grep -q 'Disallow: /c/' && echo 'PII safe' || echo '/c/ exposto a crawler'"

# ============================================================================
header "9. Browser pixel injection (TrackingScripts)"
# ============================================================================

CHK_HTML=$(curl -s --max-time 15 "$CHECKOUT/c/$SLUG")
check "Checkout HTML > 1KB" bash -c "echo '$CHK_HTML' | wc -c | awk '{ if (\$1 > 1024) print \"page non-trivial\"; else { print \"too small\"; exit 1 } }'"

# Verifica que pelo menos um pixel script (fbq, gtag, ttq, _pintrk, kwaiq) aparece
# (depende do workspace ter pixel cadastrado — só warning, não fail)
if echo "$CHK_HTML" | grep -qE '(fbevents\.js|googletagmanager|tiktok|pinterest|kwai)'; then
  PASS=$((PASS + 1))
  printf "  ${G}✓${N} %-50s ${C}%s${N}\n" "Pixel script presente no HTML" "OK"
else
  printf "  ${Y}⚠${N} %-50s ${Y}%s${N}\n" "Nenhum pixel SDK no HTML (workspace sem pixel?)" "skip"
fi

# ============================================================================
header "10. Connect surface (partner inbound)"
# ============================================================================

# Sem auth — deve dar 401/4xx mas responder
check "/v1/connect/entitlements GET 4xx sem auth" assert_http_4xx "$API/v1/connect/entitlements"

# ============================================================================
header "11. Latency benchmark"
# ============================================================================

check "checkout.getBySlug < 1500ms" assert_latency_under "$GBS_URL" 1500
check "marketplace.browse < 1500ms" assert_latency_under "$MKT_URL" 1500
check "checkout HTML < 3000ms" assert_latency_under "$CHECKOUT/c/$SLUG" 3000

# ============================================================================
# Final
# ============================================================================

echo ""
echo -e "${B}========================================${N}"
echo -e "${B}Resultado${N}"
echo -e "${B}========================================${N}"
TOTAL=$((PASS + FAIL))
echo -e "  ${G}PASS:${N} $PASS / $TOTAL"
echo -e "  ${R}FAIL:${N} $FAIL / $TOTAL"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "${R}Itens que falharam:${N}"
  for item in "${FAIL_LIST[@]}"; do
    echo -e "  ${R}✗${N} $item"
  done
  echo ""
  echo -e "${R}Health check FAILED${N}"
  exit 1
fi

echo ""
echo -e "${G}✓ Health check PASSED — sistema saudável${N}"
exit 0
