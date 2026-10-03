export const config = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://snifi:snifi@localhost:5432/snifi',
  // En production, le secret provient d'un coffre (Vault, KMS…) — jamais du code.
  jwtSecret: process.env.JWT_SECRET ?? (process.env.NODE_ENV === 'production' ? '' : 'snifi-dev-secret-ne-pas-utiliser-en-prod'),
  jwtTtl: process.env.JWT_TTL ?? '8h',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
};

if (!config.jwtSecret) {
  throw new Error('JWT_SECRET doit être défini en production');
}
