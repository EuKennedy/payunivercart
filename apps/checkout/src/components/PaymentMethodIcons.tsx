/**
 * Ícones dos métodos de pagamento usados no SubMethodTabs +
 * PixSubscriptionInfo + chip de método nos planos.
 *
 * PIX: reprodução do logo oficial do BACEN (uso institucional permitido
 * pelo Manual da Marca PIX). 4 pétalas em forma de losango. Cor padrão
 * `currentColor` pra herdar a cor do contexto; o losango oficial usa
 * `#32BCAD` em fundos claros — passe `tone="brand"` pra forçar esse valor.
 *
 * Card: ícone editorial inline (chip + listras), estilo Heroicons.
 * 100% currentColor pra adaptar ao tema.
 */

type IconProps = {
  size?: number;
  className?: string;
  tone?: 'brand' | 'inherit';
};

const PIX_BRAND_COLOR = '#32BCAD';

export function PixIcon({ size = 16, className, tone = 'brand' }: IconProps) {
  const fill = tone === 'brand' ? PIX_BRAND_COLOR : 'currentColor';
  return (
    <svg
      role="img"
      aria-label="PIX"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <title>PIX</title>
      {/* Logo oficial PIX (BACEN) — marca de 4 setas em losango. */}
      <path
        fill={fill}
        d="M11.917 11.71a2.046 2.046 0 0 1-1.454-.602l-2.1-2.1a.4.4 0 0 0-.551 0L5.704 11.115a2.044 2.044 0 0 1-1.454.602h-.414l2.66 2.66c.83.83 2.177.83 3.007 0l2.66-2.66h-.246zM4.25 8.04a2.046 2.046 0 0 1 1.454.601l2.108 2.108a.39.39 0 0 0 .552 0l2.1-2.1a2.044 2.044 0 0 1 1.453-.602h.247l-2.66-2.66a2.128 2.128 0 0 0-3.007 0l-2.66 2.66h.413zm12.62 2.197-1.609-1.61a.31.31 0 0 1-.116.024h-.713a1.446 1.446 0 0 0-1.017.422l-2.1 2.1a1.052 1.052 0 0 1-1.488 0L7.32 9.067A1.446 1.446 0 0 0 6.303 8.65H5.42a.31.31 0 0 1-.11-.022L3.692 10.24a2.128 2.128 0 0 0 0 3.007l1.62 1.612a.31.31 0 0 1 .108-.022h.883a1.446 1.446 0 0 0 1.017-.422l2.108-2.108a1.085 1.085 0 0 1 1.488 0l2.1 2.1a1.446 1.446 0 0 0 1.017.422h.713a.31.31 0 0 1 .116.023l1.609-1.608a2.128 2.128 0 0 0 0-3.007z"
      />
    </svg>
  );
}

export function CardIcon({ size = 16, className }: IconProps) {
  return (
    <svg
      role="img"
      aria-label="Cartão"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <title>Cartão de crédito</title>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <line x1="2.5" y1="10" x2="21.5" y2="10" />
      <line x1="6" y1="15" x2="9" y2="15" />
      <line x1="11" y1="15" x2="13" y2="15" />
    </svg>
  );
}
