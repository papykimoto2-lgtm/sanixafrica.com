import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config';

/** Contexte de traçabilité transmis au journal d'audit (QUI ? POURQUOI ? SOURCE ?). */
export interface AuditContext {
  utilisateur: string;
  motif?: string;
  source?: string;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  /**
   * Exécute fn dans une transaction dont chaque écriture est attribuée à ctx.
   * Les triggers d'audit lisent snifi.utilisateur / snifi.motif / snifi.source.
   */
  async tx<T>(ctx: AuditContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT set_config('snifi.utilisateur', $1, true), set_config('snifi.motif', $2, true), set_config('snifi.source', $3, true)",
        [ctx.utilisateur, ctx.motif ?? '', ctx.source ?? 'API'],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
