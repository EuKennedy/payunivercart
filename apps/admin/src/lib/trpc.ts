'use client';

import type { AppRouter } from '@payunivercart/api/routers';
import { createTRPCReact } from '@trpc/react-query';

export const trpc = createTRPCReact<AppRouter>();
