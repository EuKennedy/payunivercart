import { router } from '../trpc.js';
import { healthRouter } from './health.js';
import { whatsappRouter } from './whatsapp.js';

/**
 * Root tRPC router. Add new domain routers as they land; keep this file
 * a flat dispatch table so the client SDK type can be inferred at the
 * workspace level.
 */
export const appRouter = router({
  health: healthRouter,
  whatsapp: whatsappRouter,
});

export type AppRouter = typeof appRouter;
