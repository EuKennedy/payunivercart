/**
 * Public env for the buyer-facing checkout. Everything `NEXT_PUBLIC_*`
 * is baked into the client bundle. The checkout never sees a secret.
 */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const TRPC_URL = `${API_URL.replace(/\/$/, '')}/trpc`;
