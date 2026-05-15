'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import { createTRPCReact } from '@trpc/react-query';

/**
 * tRPC React Query bindings, fully typed off the api's `AppRouter`. The
 * client itself (with links / fetch config) is built inside the
 * `<Providers>` boundary because it owns the QueryClient.
 */
export const trpc = createTRPCReact<AppRouter>();
