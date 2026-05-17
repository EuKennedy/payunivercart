import { router } from '../trpc';
import { healthRouter } from './health';
import { productsRouter } from './products';
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
});

export type AppRouter = typeof appRouter;
