/**
 * Mercado Pago.js v2 client-side tokenization.
 *
 * Loaded lazily so checkouts that don't have an MP publishable key
 * (legacy gateways or producers without MP) never download the 60kb
 * SDK. The promise is memoised so multiple `tokenize()` calls in a
 * single session reuse the same script tag.
 *
 * Why this matters: tokenizing the card in the browser means the raw
 * PAN never hits our server (PCI scope drops to SAQ-A). The server
 * receives a one-shot token id (`<uuid>`) and exchanges it for a
 * preapproval / single payment with MP — same code path the legacy
 * `RAW:<pan>:<mm>:<yy>:<cvv>` fallback uses, except the token is real.
 */

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';

interface MercadoPagoBrowserCardToken {
  id: string;
}

interface MercadoPagoBrowserSDK {
  createCardToken: (args: {
    cardNumber: string;
    cardholderName: string;
    cardExpirationMonth: string;
    cardExpirationYear: string;
    securityCode: string;
    identificationType: 'CPF' | 'CNPJ';
    identificationNumber: string;
  }) => Promise<MercadoPagoBrowserCardToken>;
}

type MercadoPagoConstructor = new (
  publishableKey: string,
  options?: { locale?: string },
) => MercadoPagoBrowserSDK;

interface MercadoPagoGlobals {
  MercadoPago?: MercadoPagoConstructor;
}

let sdkPromise: Promise<MercadoPagoConstructor> | null = null;

function loadSdk(): Promise<MercadoPagoConstructor> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('mp-tokenize: window is not available (SSR context).'));
      return;
    }
    const existing = (window as unknown as MercadoPagoGlobals).MercadoPago;
    if (existing) {
      resolve(existing);
      return;
    }
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      const ctor = (window as unknown as MercadoPagoGlobals).MercadoPago;
      if (!ctor) {
        reject(new Error('mp-tokenize: MercadoPago global missing after SDK load.'));
        return;
      }
      resolve(ctor);
    };
    script.onerror = () => reject(new Error('mp-tokenize: failed to load MP SDK.'));
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export interface CardTokenizeInput {
  publishableKey: string;
  cardNumber: string;
  cardHolderName: string;
  expirationMonth: string; // "01".."12"
  expirationYear: string; // "2030" or "30"
  securityCode: string;
  /** CPF/CNPJ digits-only. */
  documentNumber: string;
}

/**
 * Returns a single-use card token id from MP. Throws on validation or
 * gateway error so the caller can surface a clean toast.
 */
export async function tokenizeCard(input: CardTokenizeInput): Promise<string> {
  const MercadoPago = await loadSdk();
  const instance = new MercadoPago(input.publishableKey, { locale: 'pt-BR' });
  const docDigits = input.documentNumber.replace(/\D/g, '');
  const identificationType: 'CPF' | 'CNPJ' = docDigits.length === 14 ? 'CNPJ' : 'CPF';
  const yearFour =
    input.expirationYear.length === 2 ? `20${input.expirationYear}` : input.expirationYear;
  const token = await instance.createCardToken({
    cardNumber: input.cardNumber.replace(/\s+/g, ''),
    cardholderName: input.cardHolderName.trim(),
    cardExpirationMonth: input.expirationMonth.padStart(2, '0'),
    cardExpirationYear: yearFour,
    securityCode: input.securityCode,
    identificationType,
    identificationNumber: docDigits,
  });
  if (!token?.id) {
    throw new Error('Tokenização falhou: gateway não retornou token.');
  }
  return token.id;
}
