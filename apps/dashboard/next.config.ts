import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
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
  // Our source uses NodeNext-style `.js` import suffixes that resolve to
  // `.ts` files. Webpack needs to be told the suffix is fungible —
  // otherwise `import './foo.js'` fails with "module not found" during
  // `next build` because the file on disk is `foo.ts`.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default config;
