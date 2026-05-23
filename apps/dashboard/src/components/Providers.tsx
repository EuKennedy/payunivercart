'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { useState } from 'react';
import { Toaster } from 'sonner';
import { TRPC_URL } from '../lib/env';
import { trpc } from '../lib/trpc';
import { ThemeProvider } from './ThemeProvider';

/**
 * Client-side providers: React-Query + tRPC. The QueryClient is built
 * inside `useState` so we get one per mounted instance (HMR safe) but
 * none on the server side.
 *
 * `httpBatchLink.fetch` uses `credentials: 'include'` so the
 * Better-Auth session cookie travels on every request. The api's CORS
 * config has the dashboard origin in `AUTH_TRUSTED_ORIGINS` and
 * `credentials: true`, otherwise the browser would strip the cookie.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
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
            return fetch(url, { ...options, credentials: 'include' });
          },
        }),
      ],
    }),
  );

  return (
    <ThemeProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {children}
          <Toaster position="bottom-right" richColors />
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
