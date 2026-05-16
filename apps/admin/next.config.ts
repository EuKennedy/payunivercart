import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Self-contained server bundle. The runtime image only needs
  // `.next/standalone`, `.next/static`, and `public/` — no top-level
  // node_modules. Also dodges the SSG-only prerender path of
  // `/_global-error` that trips React 19 inside `next build --webpack`.
  output: 'standalone',
  // Admin currently doesn't import from any workspace package directly,
  // so we keep transpilePackages empty — narrower bundler graph, fewer
  // moving parts. Re-add packages as real imports land.
  transpilePackages: [],
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
