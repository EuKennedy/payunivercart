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

export function PixIcon({ size = 16, className }: IconProps) {
  // Logo oficial PIX (PNG fornecido pela marca). Usamos o asset real em vez de
  // redesenhar em SVG — o losango do PIX tem geometria/cor exatas que não
  // devem ser aproximadas.
  return (
    <img
      src="/pix-logo.png"
      alt="PIX"
      width={size}
      height={size}
      className={className}
      style={{ display: 'inline-block', objectFit: 'contain' }}
      draggable={false}
    />
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
