import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@payunivercart/api',
    '@payunivercart/audit',
    '@payunivercart/crypto',
    '@payunivercart/db',
    '@payunivercart/payments',
    '@payunivercart/shared',
    '@payunivercart/waha',
  ],
  poweredByHeader: false,
  // See apps/dashboard/next.config.ts for rationale on the `.js` extension
  // alias — our workspace uses NodeNext-style imports and `next build`'s
  // webpack pass needs to know `.js` means `.ts`.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
