'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import { createTRPCReact } from '@trpc/react-query';

/**
 * tRPC React-Query bindings for the buyer checkout. Wraps the same
 * `AppRouter` the dashboard uses, but only invokes public-procedure
 * endpoints (`checkout.getBySlug`, `checkout.createOrder`).
 */
export const trpc = createTRPCReact<AppRouter>();
