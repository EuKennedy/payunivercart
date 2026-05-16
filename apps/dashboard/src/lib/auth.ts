'use client';

// Import from `/client` (not the package root) so webpack's client bundle
// never follows the server-side re-exports — which would drag postgres,
// `fs`, `perf_hooks`, etc. into a browser bundle and fail the build.
import { createPayunivercartAuthClient } from '@payunivercart/auth/client';
import { AUTH_BASE_URL } from './env.js';

/**
 * Singleton Better-Auth browser client. Imported by every component that
 * needs to sign in, sign up, log out, or check the current session.
 *
 * The cookie used by Better-Auth is set on `API_URL`'s origin; the
 * dashboard's CORS config on the api side already declares the dashboard
 * origin as trusted with `credentials: true`.
 */
export const authClient = createPayunivercartAuthClient(AUTH_BASE_URL);

export const { signIn, signUp, signOut, useSession } = authClient;
