import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Skip ESLint + tsc inside `next build`. CI runs both jobs
  // separately so the same checks still gate every PR; disabling
  // here cuts ~150–300 MB of peak build RAM and keeps the Coolify
  // VPS from OOM-killing the deploy mid-typecheck.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  output: 'standalone',
  experimental: {
    outputFileTracingRoot: path.resolve(__dirname, '../../'),
  },
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
