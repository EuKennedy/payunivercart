import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Skip ESLint + tsc inside `next build`. The CI runs both jobs
  // separately so the same checks are still enforced on every PR;
  // disabling here cuts ~150–300 MB of peak RAM out of the build,
  // which kept OOM-killing the Coolify VPS mid-deploy.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // Standalone output: self-contained bundle with only required deps.
  // Runtime image copies .next/standalone + .next/static + public —
  // ~150 MB instead of the full 1 GB /repo tree.
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages are included.
  // Top-level since Next 15 — under `experimental` it is silently ignored,
  // which lets `next build` trace from the default root and walk the whole
  // monorepo, OOM-killing the Coolify VPS (the "exit code 255" deploys).
  outputFileTracingRoot: path.resolve(__dirname, '../../'),
  experimental: {
    // Enable server actions for the auth flow forms.
    serverActions: { bodySizeLimit: '1mb' },
  },
  // Transpile workspace packages so Next.js can consume their `src/*.ts`
  // entry points without each one needing its own build step.
  transpilePackages: [
    '@payunivercart/api',
    '@payunivercart/audit',
    '@payunivercart/auth',
    '@payunivercart/crypto',
    '@payunivercart/db',
    '@payunivercart/payments',
    '@payunivercart/shared',
    '@payunivercart/waha',
  ],
  poweredByHeader: false,
};

export default config;
