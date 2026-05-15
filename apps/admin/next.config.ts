import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@payunivercart/api', '@payunivercart/auth', '@payunivercart/shared'],
  poweredByHeader: false,
};

export default config;
