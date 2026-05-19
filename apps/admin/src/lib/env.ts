/**
 * Public env for the super-admin app. Same shape as the dashboard's
 * `lib/env.ts` — kept independent so the two apps can drift their
 * surfaces without leaking config across.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const AUTH_BASE_URL = `${API_URL.replace(/\/$/, '')}/api/auth`;
export const TRPC_URL = `${API_URL.replace(/\/$/, '')}/trpc`;
