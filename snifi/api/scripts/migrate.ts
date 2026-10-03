/**
 * Applique les migrations SQL de ../db/migrations dans l'ordre, une seule fois chacune.
 *   npm run db:migrate            migrations
 *   npm run db:seed               migrations + jeu de démonstration
 *   ts-node scripts/migrate.ts --reset --seed   base de test remise à zéro
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { config } from '../src/config';

const DB_DIR = join(__dirname, '..', '..', 'db');

export async function migrate(opts: { reset?: boolean; seed?: boolean; log?: boolean } = {}) {
  const client = new Client({ connectionString: config.databaseUrl });
  const log = opts.log === false ? () => undefined : console.log;
  await client.connect();
  try {
    if (opts.reset) {
      await client.query('DROP SCHEMA IF EXISTS snifi CASCADE; DROP TABLE IF EXISTS public.snifi_migrations');
      log('schéma snifi supprimé');
    }
    await client.query(
      'CREATE TABLE IF NOT EXISTS public.snifi_migrations (fichier text PRIMARY KEY, applique_le timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT fichier FROM public.snifi_migrations')).rows.map((r) => r.fichier));
    const files = readdirSync(join(DB_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(DB_DIR, 'migrations', f), 'utf8'));
        await client.query('INSERT INTO public.snifi_migrations (fichier) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`migration appliquée : ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`échec de la migration ${f} : ${(e as Error).message}`);
      }
    }
    if (opts.seed) {
      const seeded = await client.query("SELECT 1 FROM public.snifi_migrations WHERE fichier = 'seed/demo.sql'");
      if (seeded.rowCount === 0) {
        await client.query('BEGIN');
        await client.query(readFileSync(join(DB_DIR, 'seed', 'demo.sql'), 'utf8'));
        await client.query("INSERT INTO public.snifi_migrations (fichier) VALUES ('seed/demo.sql')");
        await client.query('COMMIT');
        log('jeu de démonstration chargé');
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  migrate({ reset: args.includes('--reset'), seed: args.includes('--seed') }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
