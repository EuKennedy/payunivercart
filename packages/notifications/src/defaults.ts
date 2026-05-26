/**
 * Catalogue of platform-default templates per event + channel.
 *
 * One source of truth for:
 *   - Which events the producer can customise
 *   - Which variables each event exposes (drives the editor UI's
 *     "insert variable" chips and the renderer's validation)
 *   - The default subject + body when a workspace hasn't overridden
 *
 * `variables` is the closed list of placeholders the renderer accepts
 * for an event. Anything outside this set is left as a literal
 * `{unknown}` after render so producers can spot a typo without us
 * silently dropping their copy.
 */

export type NotificationEventKey =
  | 'order_paid_buyer'
  | 'order_paid_producer'
  | 'subscription_activated_buyer'
  | 'subscription_activated_producer'
  | 'entitlement_granted'
  | 'cart_recovery';

export type NotificationChannel = 'email' | 'whatsapp';

export interface EventVariable {
  /** The placeholder key without braces. Producers see `{key}`. */
  key: string;
  /** Plain-language label rendered next to the chip. */
  label: string;
  /** Sample value used in the preview pane so producers see what the
   *  message will look like once a real order fires. */
  sample: string;
}

export interface TemplateDefault {
  /** NULL for whatsapp / sms; required for email. */
  subject: string | null;
  body: string;
}

export interface EventDefinition {
  key: NotificationEventKey;
  /** Human title for the editor card. */
  title: string;
  /** One-line description shown under the title. */
  description: string;
  /** Closed enumeration of placeholders this event publishes. */
  variables: EventVariable[];
  /** Built-in template per channel. Channels not listed cannot be
   *  customised for this event. */
  defaults: Partial<Record<NotificationChannel, TemplateDefault>>;
}

/**
 * Common identity variables every event exposes. Listing them here
 * avoids drift between events (e.g. `{brand}` meaning different things
 * in different templates).
 */
const COMMON: EventVariable[] = [
  { key: 'brand', label: 'Nome da marca', sample: 'Acme Cursos' },
  { key: 'nome', label: 'Primeiro nome do cliente', sample: 'Diego' },
];

export const NOTIFICATION_EVENTS: EventDefinition[] = [
  {
    key: 'order_paid_buyer',
    title: 'Pagamento confirmado — comprador',
    description: 'Disparado para o comprador assim que o gateway confirma o pagamento.',
    variables: [
      ...COMMON,
      { key: 'produto', label: 'Nome do produto', sample: 'Mentoria Tráfego Pago' },
      { key: 'valor', label: 'Valor pago (formatado)', sample: 'R$ 997,00' },
      { key: 'codigo', label: 'Código do pedido', sample: 'ORD-A1B2C3' },
      { key: 'acesso', label: 'URL de acesso ou instruções', sample: 'https://meucurso.com/login' },
    ],
    defaults: {
      email: {
        subject: '{brand} — pagamento confirmado · {codigo}',
        body: [
          'Oi {nome},',
          '',
          'Recebemos o pagamento do seu pedido {codigo} ({produto}, {valor}).',
          '',
          '{acesso}',
          '',
          'Obrigado!',
        ].join('\n'),
      },
      whatsapp: {
        subject: null,
        body: 'Oi {nome}! Pagamento de *{produto}* confirmado ✅\nPedido {codigo} · {valor}.\n\n— {brand}',
      },
    },
  },
  {
    key: 'order_paid_producer',
    title: 'Pagamento confirmado — produtor',
    description: 'Alerta interno enviado para o número do produtor a cada venda confirmada.',
    variables: [
      ...COMMON,
      { key: 'produto', label: 'Nome do produto', sample: 'Mentoria Tráfego Pago' },
      { key: 'valor', label: 'Valor pago (formatado)', sample: 'R$ 997,00' },
      { key: 'codigo', label: 'Código do pedido', sample: 'ORD-A1B2C3' },
      { key: 'cliente', label: 'Nome completo do comprador', sample: 'Diego Silva' },
    ],
    defaults: {
      whatsapp: {
        subject: null,
        body: '💰 Venda nova em *{brand}*\n{cliente} comprou *{produto}* por {valor}.\nPedido {codigo}.',
      },
    },
  },
  {
    key: 'subscription_activated_buyer',
    title: 'Assinatura ativada — assinante',
    description: 'Confirmação enviada ao cliente quando a assinatura é ativada pela primeira vez.',
    variables: [
      ...COMMON,
      { key: 'produto', label: 'Nome do produto', sample: 'Comunidade Mensal' },
      { key: 'valor', label: 'Valor da mensalidade', sample: 'R$ 97,00' },
      { key: 'codigo', label: 'Código da assinatura', sample: 'SUB-X9Y8Z7' },
      { key: 'acesso', label: 'URL de acesso ou instruções', sample: 'https://comunidade.com' },
    ],
    defaults: {
      email: {
        subject: '{brand} — assinatura ativada · {codigo}',
        body: [
          'Oi {nome},',
          '',
          'Sua assinatura de {produto} ({valor}/mês) está ativa.',
          '',
          '{acesso}',
          '',
          'Obrigado!',
        ].join('\n'),
      },
      whatsapp: {
        subject: null,
        body: 'Oi {nome}! Assinatura de *{produto}* ativada ✅\nCódigo {codigo}.\n\n— {brand}',
      },
    },
  },
  {
    key: 'subscription_activated_producer',
    title: 'Assinatura ativada — produtor',
    description: 'Alerta interno para o produtor a cada nova assinatura.',
    variables: [
      ...COMMON,
      { key: 'produto', label: 'Nome do produto', sample: 'Comunidade Mensal' },
      { key: 'valor', label: 'Valor da mensalidade', sample: 'R$ 97,00' },
      { key: 'codigo', label: 'Código da assinatura', sample: 'SUB-X9Y8Z7' },
      { key: 'cliente', label: 'Nome completo do assinante', sample: 'Diego Silva' },
    ],
    defaults: {
      whatsapp: {
        subject: null,
        body: '💰 Nova assinatura em *{brand}*\n{cliente} assinou *{produto}* por {valor}/mês.\nCódigo {codigo}.',
      },
    },
  },
  {
    key: 'entitlement_granted',
    title: 'Acesso liberado — Univercart Connect',
    description: 'Magic-link enviado quando uma assinatura provisiona acesso em um SaaS parceiro.',
    variables: [
      ...COMMON,
      { key: 'parceiro', label: 'Nome do parceiro', sample: 'AcmeSaaS' },
      { key: 'produto', label: 'Nome do produto', sample: 'Plano Pro' },
      { key: 'link', label: 'URL do magic-link', sample: 'https://acme.com/auth?t=xyz' },
    ],
    defaults: {
      email: {
        subject: 'Seu acesso ao {parceiro} está pronto',
        body: [
          'Oi {nome}!',
          '',
          'Sua assinatura de "{produto}" foi confirmada e seu acesso ao {parceiro} já está liberado.',
          '',
          'Defina sua senha pelo link:',
          '{link}',
          '',
          'O link expira em 72 horas. Se precisar, peça um novo ao produtor.',
        ].join('\n'),
      },
      whatsapp: {
        subject: null,
        body: 'Olá, {nome}! 👋\n\nSua assinatura de *{produto}* foi confirmada e seu acesso ao {parceiro} está pronto.\n\nDefina sua senha pelo link (válido 72h):\n{link}',
      },
    },
  },
  {
    key: 'cart_recovery',
    title: 'Recuperação de carrinho — padrão',
    description:
      'Modelo padrão para novas campanhas de recuperação. Campanhas existentes continuam usando seus próprios passos.',
    variables: [
      ...COMMON,
      { key: 'produto', label: 'Nome do produto', sample: 'Mentoria Tráfego Pago' },
      { key: 'valor', label: 'Valor da venda', sample: 'R$ 997,00' },
      { key: 'codigo', label: 'Código do pedido', sample: 'ORD-A1B2C3' },
      { key: 'link', label: 'Link de pagamento', sample: 'https://checkout.acme.com/c/abc' },
    ],
    defaults: {
      email: {
        subject: '{brand} — seu Pix de {produto} ainda está reservado',
        body: [
          'Oi {nome},',
          '',
          'Separamos sua vaga em {produto} mas o pagamento ainda não chegou. Total {valor}.',
          '',
          'Concluir pagamento: {link}',
          '',
          'Pedido {codigo} — este link expira em algumas horas.',
        ].join('\n'),
      },
      whatsapp: {
        subject: null,
        body: 'Oi {nome}, faltou o pagamento de *{produto}* ({valor}).\n\nFinalize aqui: {link}\nPedido {codigo}.',
      },
    },
  },
];

/** Look up an event definition by key. Returns `undefined` for keys
 *  outside the catalogue — callers should treat this as "stop, ship a
 *  default" rather than throwing. */
export function findEvent(key: string): EventDefinition | undefined {
  return NOTIFICATION_EVENTS.find((e) => e.key === key);
}
