'use client';

import { createPayunivercartAuthClient } from '@payunivercart/auth/client';
import { AUTH_BASE_URL } from './env';

export const authClient = createPayunivercartAuthClient(AUTH_BASE_URL);
export const { signIn, signOut, useSession } = authClient;
