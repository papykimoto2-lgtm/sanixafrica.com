import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../common/auth';
import { ECRITURE } from '../common/roles';
import { offset, pagination, Valider } from '../common/validation';
import { DbService } from '../db/db.service';

const recherche = pagination.extend({
  table: z.string().optional(),
  utilisateur: z.string().optional(),
  ligne_id: z.string().optional(),
});

@Controller('audit')
export class AuditController {
  constructor(private readonly db: DbService) {}

  @Roles(...ECRITURE.audit)
  @Get()
  async journal(@Query(new Valider(recherche)) q: z.infer<typeof recherche>) {
    const params: unknown[] = [];
    const where = ['true'];
    if (q.table) { params.push(q.table); where.push(`table_nom = $${params.length}`); }
    if (q.utilisateur) { params.push(`%${q.utilisateur}%`); where.push(`utilisateur ILIKE $${params.length}`); }
    if (q.ligne_id) { params.push(q.ligne_id); where.push(`ligne_id = $${params.length}`); }
    params.push(q.taille, offset(q));
    return this.db.query(
      `SELECT * FROM snifi.journal_audit WHERE ${where.join(' AND ')} ORDER BY id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  }

  /** Vérifie la chaîne de hachage du journal : toute altération a posteriori est détectée. */
  @Roles(...ECRITURE.audit)
  @Get('verification')
  async verifier() {
    const rupture = await this.db.one('SELECT * FROM snifi.verifier_journal()');
    const total = await this.db.one('SELECT count(*)::int AS n, max(id) AS dernier FROM snifi.journal_audit');
    return { integre: !rupture, entrees: total.n, derniere_entree: total.dernier, rupture: rupture ?? null };
  }
}
