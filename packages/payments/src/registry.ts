import { type GatewayId, PayunivercartError } from '@payunivercart/shared';
import { MercadoPagoAdapter } from './adapters/mercadopago';
import { PagarmeAdapter } from './adapters/pagarme';
import { PagSeguroAdapter } from './adapters/pagseguro';
import { StripeAdapter } from './adapters/stripe';
import type { PaymentGateway } from './types';

/**
 * Lazy singleton registry of every supported gateway adapter.
 * Adapters are stateless and shared across all workspaces.
 */
const registry = new Map<GatewayId, PaymentGateway>();

function build(id: GatewayId): PaymentGateway {
  switch (id) {
    case 'mercadopago':
      return new MercadoPagoAdapter() as unknown as PaymentGateway;
    case 'pagarme':
      return new PagarmeAdapter() as unknown as PaymentGateway;
    case 'pagseguro':
      return new PagSeguroAdapter() as unknown as PaymentGateway;
    case 'stripe':
      return new StripeAdapter() as unknown as PaymentGateway;
  }
}

export function getAdapter(id: GatewayId): PaymentGateway {
  const cached = registry.get(id);
  if (cached) return cached;

  const adapter = build(id);
  if (!adapter) {
    throw new PayunivercartError({
      code: 'INTERNAL',
      message: `No payment adapter registered for "${id}"`,
    });
  }
  registry.set(id, adapter);
  return adapter;
}
