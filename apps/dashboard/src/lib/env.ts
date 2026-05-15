/**
 * Public env vars for the dashboard. Anything `NEXT_PUBLIC_*` is baked
 * into the client bundle; everything else stays server-only. We never
 * inline a secret into a `NEXT_PUBLIC_*` name.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const AUTH_BASE_URL = `${API_URL.replace(/\/$/, '')}/api/auth`;
export const TRPC_URL = `${API_URL.replace(/\/$/, '')}/trpc`;
