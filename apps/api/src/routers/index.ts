import { router } from '../trpc';
import { adminRouter } from './admin';
import { affiliatesRouter } from './affiliates';
import { checkoutRouter } from './checkout';
import { customersRouter } from './customers';
import { gatewaysRouter } from './gateways';
import { healthRouter } from './health';
import { marketplaceRouter } from './marketplace';
import { metricsRouter } from './metrics';
import { notificationTemplatesRouter } from './notification-templates';
import { notificationsRouter } from './notifications';
import { ordersRouter } from './orders';
import { partnersRouter } from './partners';
import { productsRouter } from './products';
import { recoveryRouter } from './recovery';
import { subscriptionsRouter } from './subscriptions';
import { trackingRouter } from './tracking';
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
  customers: customersRouter,
  subscriptions: subscriptionsRouter,
  partners: partnersRouter,
  affiliates: affiliatesRouter,
  tracking: trackingRouter,
  marketplace: marketplaceRouter,
  notifications: notificationsRouter,
  notificationTemplates: notificationTemplatesRouter,
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;
