import { router } from '../trpc';
import { checkoutRouter } from './checkout';
import { gatewaysRouter } from './gateways';
import { healthRouter } from './health';
import { metricsRouter } from './metrics';
import { ordersRouter } from './orders';
import { productsRouter } from './products';
import { recoveryRouter } from './recovery';
import { whatsappRouter } from './whatsapp';
import { workspaceRouter } from './workspace';

/**
 * Root tRPC router. Add new domain routers as they land; keep this file
 * a flat dispatch table so the client SDK type can be inferred at the
 * workspace level.
 */
export const appRouter = router({
  health: healthRouter,
  whatsapp: whatsappRouter,
  workspace: workspaceRouter,
  products: productsRouter,
  checkout: checkoutRouter,
  gateways: gatewaysRouter,
  metrics: metricsRouter,
  recovery: recoveryRouter,
  orders: ordersRouter,
});

export type AppRouter = typeof appRouter;
