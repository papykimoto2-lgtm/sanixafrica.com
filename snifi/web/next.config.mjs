/** @type {import('next').NextConfig} */
const API_URL = process.env.SNIFI_API_URL ?? 'http://localhost:3001';

export default {
  reactStrictMode: true,
  // Le navigateur ne parle qu'au frontal ; l'API reste derrière (pas de CORS à ouvrir).
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
};
