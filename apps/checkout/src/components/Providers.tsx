'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState } from 'react';
import { TRPC_URL } from '../lib/env';
import { trpc } from '../lib/trpc';

/**
 * Checkout providers. Smaller than the dashboard's — no session,
 * no shared queries, no sidebar. The checkout is a single-form
 * conversion surface; React Query is here only to cache the product
 * lookup so a Pix-confirmation round-trip doesn't re-fetch it.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: TRPC_URL,
          fetch(url, options) {
            // No `credentials: 'include'` — checkout is anonymous and
            // we deliberately don't send any cookies to the api so the
            // buyer's session (if they happen to be logged into a
            // payunivercart producer account in another tab) cannot
            // leak into the order.
            return fetch(url, { ...options });
          },
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
