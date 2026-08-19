import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // This repo lives inside another checkout that has its own lockfile. Without this, Next
  // infers the wrong workspace root and traces the wrong file set into the deployed
  // function bundle.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
}

export default nextConfig
