import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Audit, Roles, Utilisateur } from '../common/auth';
import { ECRITURE, LECTURE, UtilisateurCourant } from '../common/roles';
import { filtreTerritoire } from '../common/territoire';
import { dateIso, motifObligatoire, offset, pagination, uuid, Valider } from '../common/validation';
import { AuditContext, DbService } from '../db/db.service';

const TYPES = ['vente', 'acquisition', 'donation', 'succession', 'mutation', 'subdivision', 'regroupement',
  'changement_usage', 'transfert_droits'] as const;
/** Événements qui transfèrent un droit réel du cédant vers l'acquéreur. */
const TRANSFERTS = ['vente', 'acquisition', 'donation', 'succession', 'mutation', 'transfert_droits'];

const creation = z.object({
  type: z.enum(TYPES),
  parcelle_id: uuid,
  date_evenement: dateIso,
  valeur: z.number().nonnegative().optional(),
  cedant_id: uuid.optional(),
  acquereur_id: uuid.optional(),
  acteur: z.string().optional(),
  document_ref: z.string().optional(),
  source_code: z.string().default('SNIFI'),
  statut: z.enum(['enregistree', 'validee']).default('enregistree'),
}).refine((t) => !TRANSFERTS.includes(t.type) || t.acquereur_id, {
  message: 'Un acquéreur est requis pour un transfert de droits', path: ['acquereur_id'],
});
const recherche = pagination.extend({ statut: z.string().optional(), type: z.enum(TYPES).optional() });
const action = z.object({ motif: motifObligatoire });

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly db: DbService) {}

  @Roles(...LECTURE)
  @Get()
  async lister(@Query(new Valider(recherche)) q: z.infer<typeof recherche>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [];
    const where = [filtreTerritoire(u, 'p.commune_code', params)];
    if (q.statut) { params.push(q.statut); where.push(`t.statut = $${params.length}`); }
    if (q.type) { params.push(q.type); where.push(`t.type = $${params.length}`); }
    params.push(q.taille, offset(q));
    const rows = await this.db.query(
      `SELECT t.*, p.snifi_id AS parcelle_snifi_id, c.nom AS cedant, a.nom AS acquereur,
              CASE WHEN p.superficie_m2 > 0 THEN round(t.valeur / p.superficie_m2) END AS valeur_m2,
              count(*) OVER ()::int AS total
         FROM snifi.transactions t JOIN snifi.parcelles p ON p.id = t.parcelle_id
         LEFT JOIN snifi.proprietaires c ON c.id = t.cedant_id LEFT JOIN snifi.proprietaires a ON a.id = t.acquereur_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.date_evenement DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { total: rows[0]?.total ?? 0, page: q.page, elements: rows.map(({ total, ...r }) => r) };
  }

  @Roles(...ECRITURE.transactions)
  @Post()
  creer(@Body(new Valider(creation)) t: z.infer<typeof creation>, @Audit() ctx: AuditContext) {
    return this.db.tx({ ...ctx, source: t.source_code }, async (c) => (await c.query(
      `INSERT INTO snifi.transactions (type, parcelle_id, date_evenement, valeur, cedant_id, acquereur_id, acteur, document_ref, source_code, statut)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [t.type, t.parcelle_id, t.date_evenement, t.valeur, t.cedant_id, t.acquereur_id, t.acteur, t.document_ref, t.source_code, t.statut],
    )).rows[0]);
  }

  @Roles(...ECRITURE.appliquerTransaction)
  @Post(':id/valider')
  valider(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(action)) _: unknown, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query("UPDATE snifi.transactions SET statut = 'validee' WHERE id = $1 AND statut = 'enregistree' RETURNING *", [id]);
      if (!r.rowCount) throw new BadRequestException('Transaction introuvable ou déjà validée');
      return r.rows[0];
    });
  }

  /**
   * Répercute l'événement dans le référentiel : clôture des droits du cédant et ouverture
   * d'un droit équivalent pour l'acquéreur (même quote-part), à la date de l'événement.
   */
  @Roles(...ECRITURE.appliquerTransaction)
  @Post(':id/appliquer')
  appliquer(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(action)) _: unknown, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const t = (await c.query('SELECT * FROM snifi.transactions WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t) throw new NotFoundException('Transaction introuvable');
      if (!['enregistree', 'validee'].includes(t.statut)) throw new BadRequestException(`Transaction déjà ${t.statut}`);

      let droitsCrees = 0;
      if (TRANSFERTS.includes(t.type)) {
        const posterieur = await c.query(
          `SELECT 1 FROM snifi.droits WHERE parcelle_id = $1 AND date_fin IS NULL AND ($2::uuid IS NULL OR proprietaire_id = $2)
              AND date_debut > $3`, [t.parcelle_id, t.cedant_id, t.date_evenement]);
        if (posterieur.rowCount) {
          throw new BadRequestException("La date de l'événement est antérieure au droit du cédant : vérification requise");
        }
        const clos = await c.query(
          `UPDATE snifi.droits SET date_fin = $3
            WHERE parcelle_id = $1 AND date_fin IS NULL AND ($2::uuid IS NULL OR proprietaire_id = $2)
            RETURNING type_droit, quote_part`,
          [t.parcelle_id, t.cedant_id, t.date_evenement]);
        if (t.cedant_id && !clos.rowCount) {
          throw new BadRequestException("Le cédant ne détient aucun droit actif sur cette parcelle : vérification requise");
        }
        const parType = new Map<string, number>();
        for (const d of clos.rows) parType.set(d.type_droit, (parType.get(d.type_droit) ?? 0) + Number(d.quote_part));
        if (!parType.size) parType.set('propriete', 1);
        for (const [type, quote] of parType) {
          await c.query(
            `INSERT INTO snifi.droits (proprietaire_id, parcelle_id, type_droit, quote_part, date_debut, transaction_id, document_ref, source_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [t.acquereur_id, t.parcelle_id, type, Math.min(quote, 1), t.date_evenement, t.id, t.document_ref, t.source_code]);
          droitsCrees++;
        }
      }
      const r = await c.query("UPDATE snifi.transactions SET statut = 'appliquee', appliquee_le = now() WHERE id = $1 RETURNING *", [id]);
      return { ...r.rows[0], droits_crees: droitsCrees };
    });
  }
}
