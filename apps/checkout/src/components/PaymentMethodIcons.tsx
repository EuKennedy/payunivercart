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

export function PixIcon({ size = 16, className, tone = 'inherit' }: IconProps) {
  const fill = tone === 'brand' ? PIX_BRAND_COLOR : 'currentColor';
  return (
    <svg
      role="img"
      aria-label="PIX"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <title>PIX</title>
      {/* Pétala superior */}
      <path
        fill={fill}
        d="M255.9 7.9c-7 0-13.7 2.8-18.6 7.7l-94.4 94.4 38.3 38.3a93.4 93.4 0 0 1 132.4 0l38.3-38.3-77.4-94.4a26.3 26.3 0 0 0-18.6-7.7z"
      />
      {/* Pétala esquerda */}
      <path
        fill={fill}
        d="M15.6 237.3 7.9 256l7.7 18.7 94.4 94.4 38.3-38.3a93.4 93.4 0 0 1 0-149.6L110 142.9 15.6 237.3z"
      />
      {/* Pétala direita */}
      <path
        fill={fill}
        d="M496.4 237.3 402 142.9l-38.3 38.3a93.4 93.4 0 0 1 0 149.6l38.3 38.3 94.4-94.4 7.7-18.7-7.7-18.7z"
      />
      {/* Pétala inferior */}
      <path
        fill={fill}
        d="M255.9 504.1a26.3 26.3 0 0 0 18.6-7.7l94.4-94.4-38.3-38.3a93.4 93.4 0 0 1-149.6 0l-38.3 38.3 94.4 94.4a26.3 26.3 0 0 0 18.8 7.7z"
      />
      {/* Núcleo central — círculo simbolizando a conexão */}
      <circle fill={fill} cx="256" cy="256" r="58" opacity="0.95" />
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
