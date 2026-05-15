import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Enable server actions for the auth flow forms.
    serverActions: { bodySizeLimit: '1mb' },
  },
  // Transpile workspace packages so Next.js can consume their `src/*.ts`
  // entry points without each one needing its own build step.
  transpilePackages: ['@payunivercart/api', '@payunivercart/auth', '@payunivercart/shared'],
  poweredByHeader: false,
};

export default config;
