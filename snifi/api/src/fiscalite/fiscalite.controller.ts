import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Audit, Roles, Utilisateur } from '../common/auth';
import { ECRITURE, LECTURE, UtilisateurCourant } from '../common/roles';
import { filtreTerritoire } from '../common/territoire';
import { dateIso, motifObligatoire, uuid, Valider } from '../common/validation';
import { AuditContext, DbService } from '../db/db.service';

const exercice = z.coerce.number().int().min(2000).max(2100);

const regle = z.object({
  code: z.string().trim().min(2),
  libelle: z.string().trim().min(2),
  impot: z.string().trim().min(2),
  assiette: z.enum(['valeur_locative', 'valeur_venale', 'surface_batie', 'surface_terrain']),
  usage: z.string().optional(),
  taux: z.number().nonnegative(),
  abattement: z.number().min(0).lt(1).default(0),
  applique_zone: z.boolean().default(false),
  date_debut: dateIso,
  date_fin: dateIso.optional(),
  reference_legale: z.string().optional(),
});
const calcul = z.object({ exercice, motif: z.string().default('Calcul des impositions théoriques') });
const liquidation = z.object({
  exercice,
  date_echeance: dateIso,
  parcelle_id: uuid.optional(),
  motif: motifObligatoire,
});
const paiement = z.object({
  imposition_id: uuid,
  montant: z.number().positive(),
  date_paiement: dateIso,
  reference: z.string().trim().min(3),
  mode: z.string().optional(),
  source_code: z.string().optional(),
});
const exoneration = z.object({
  parcelle_id: uuid,
  impot: z.string().optional(),
  taux: z.number().gt(0).max(1).default(1),
  motif_exoneration: z.string().trim().min(3),
  date_debut: dateIso,
  date_fin: dateIso.optional(),
  document_ref: z.string().optional(),
});
const filtreExercice = z.object({ exercice: exercice.optional() });

@Controller('fiscalite')
export class FiscaliteController {
  constructor(private readonly db: DbService) {}

  // --- Règles paramétrables ---------------------------------------------------
  @Roles(...LECTURE)
  @Get('regles')
  regles() {
    return this.db.query('SELECT * FROM snifi.regles_fiscales ORDER BY impot, code, date_debut DESC');
  }

  @Roles(...ECRITURE.reglesFiscales)
  @Post('regles')
  creerRegle(@Body(new Valider(regle)) r: z.infer<typeof regle>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => (await c.query(
      `INSERT INTO snifi.regles_fiscales (code, libelle, impot, assiette, usage, taux, abattement, applique_zone, date_debut, date_fin, reference_legale)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [r.code, r.libelle, r.impot, r.assiette, r.usage, r.taux, r.abattement, r.applique_zone, r.date_debut, r.date_fin, r.reference_legale],
    )).rows[0]);
  }

  // --- Calcul / liquidation / paiements ----------------------------------------
  /** Calcule les montants théoriques. Les impositions déjà liquidées ne sont pas modifiées. */
  @Roles(...ECRITURE.fiscalite)
  @Post('calcul')
  calculer(@Body(new Valider(calcul)) b: z.infer<typeof calcul>, @Audit() ctx: AuditContext) {
    return this.db.tx({ ...ctx, motif: b.motif, source: 'MOTEUR-FISCAL' }, async (c) => {
      const r = await c.query('SELECT snifi.calculer_impositions($1) AS n', [b.exercice]);
      return { exercice: b.exercice, impositions_calculees: r.rows[0].n };
    });
  }

  /** Liquidation : le montant théorique devient le montant émis par l'administration. */
  @Roles(...ECRITURE.fiscalite)
  @Post('liquidation')
  liquider(@Body(new Valider(liquidation)) b: z.infer<typeof liquidation>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `UPDATE snifi.impositions SET montant_liquide = montant_theorique, date_echeance = $2, statut = 'liquidee'
          WHERE exercice = $1 AND statut = 'calculee' AND ($3::uuid IS NULL OR parcelle_id = $3)
          RETURNING montant_liquide`,
        [b.exercice, b.date_echeance, b.parcelle_id ?? null]);
      return {
        exercice: b.exercice,
        impositions_liquidees: r.rowCount,
        montant_total: r.rows.reduce((s, x) => s + Number(x.montant_liquide), 0),
      };
    });
  }

  @Roles(...ECRITURE.fiscalite)
  @Post('paiements')
  payer(@Body(new Valider(paiement)) p: z.infer<typeof paiement>, @Audit() ctx: AuditContext) {
    return this.db.tx({ ...ctx, motif: ctx.motif ?? `Paiement ${p.reference}` }, async (c) => {
      const imp = await c.query('SELECT statut FROM snifi.impositions WHERE id = $1 FOR UPDATE', [p.imposition_id]);
      if (!imp.rowCount) throw new NotFoundException('Imposition introuvable');
      if (!['liquidee', 'soldee'].includes(imp.rows[0].statut)) {
        throw new BadRequestException("Un paiement ne peut être enregistré que sur une imposition liquidée");
      }
      const r = await c.query(
        `INSERT INTO snifi.paiements (imposition_id, montant, date_paiement, reference, mode, source_code)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [p.imposition_id, p.montant, p.date_paiement, p.reference, p.mode, p.source_code]);
      await c.query(
        `UPDATE snifi.impositions i SET statut = 'soldee'
          WHERE i.id = $1 AND i.statut = 'liquidee'
            AND (SELECT sum(montant) FROM snifi.paiements WHERE imposition_id = i.id) >= i.montant_liquide`,
        [p.imposition_id]);
      return r.rows[0];
    });
  }

  @Roles(...ECRITURE.fiscalite)
  @Post('exonerations')
  exonerer(@Body(new Valider(exoneration)) e: z.infer<typeof exoneration>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => (await c.query(
      `INSERT INTO snifi.exonerations (parcelle_id, impot, taux, motif, date_debut, date_fin, document_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [e.parcelle_id, e.impot, e.taux, e.motif_exoneration, e.date_debut, e.date_fin, e.document_ref],
    )).rows[0]);
  }

  // --- Dossier fiscal immobilier ----------------------------------------------
  @Roles(...LECTURE, 'proprietaire')
  @Get('dossier/:parcelleId')
  async dossier(@Param('parcelleId', ParseUUIDPipe) id: string, @Query(new Valider(filtreExercice)) q: z.infer<typeof filtreExercice>,
                @Utilisateur() u: UtilisateurCourant) {
    if (u.role === 'proprietaire') {
      const ok = await this.db.one('SELECT 1 FROM snifi.droits WHERE parcelle_id = $1 AND proprietaire_id = $2', [id, u.proprietaire_id]);
      if (!ok) throw new NotFoundException();
    }
    const params = [id, q.exercice ?? null];
    const [synthese, impositions, declarations, exonerations] = await Promise.all([
      this.db.query(
        `SELECT v.*, o.nom AS proprietaire FROM snifi.v_dossier_fiscal v JOIN snifi.proprietaires o ON o.id = v.proprietaire_id
          WHERE v.parcelle_id = $1 AND ($2::int IS NULL OR v.exercice = $2) ORDER BY v.exercice DESC`, params),
      this.db.query(
        `SELECT i.*, r.code AS regle_code, r.libelle AS regle, o.nom AS proprietaire,
                (SELECT coalesce(sum(p.montant), 0) FROM snifi.paiements p WHERE p.imposition_id = i.id) AS montant_paye,
                (SELECT coalesce(json_agg(p ORDER BY p.date_paiement), '[]') FROM snifi.paiements p WHERE p.imposition_id = i.id) AS paiements
           FROM snifi.impositions i JOIN snifi.regles_fiscales r ON r.id = i.regle_id JOIN snifi.proprietaires o ON o.id = i.proprietaire_id
          WHERE i.parcelle_id = $1 AND ($2::int IS NULL OR i.exercice = $2) ORDER BY i.exercice DESC, r.code`, params),
      this.db.query('SELECT * FROM snifi.declarations WHERE parcelle_id = $1 AND ($2::int IS NULL OR exercice = $2) ORDER BY exercice DESC', params),
      this.db.query('SELECT * FROM snifi.exonerations WHERE parcelle_id = $1 ORDER BY date_debut DESC', [id]),
    ]);
    const arrieres = await this.db.one(
      `SELECT coalesce(sum(solde), 0) AS montant FROM snifi.v_dossier_fiscal
        WHERE parcelle_id = $1 AND prochaine_echeance < current_date AND solde > 0`, [id]);
    return { synthese, impositions, declarations, exonerations, arrieres: Number(arrieres.montant) };
  }

  /** Potentiel / liquidation / recouvrement / écart par commune. */
  @Roles(...LECTURE)
  @Get('synthese')
  synthese(@Query(new Valider(filtreExercice)) q: z.infer<typeof filtreExercice>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [q.exercice ?? null];
    return this.db.query(
      `SELECT p.commune_code, t.nom AS commune, v.exercice,
              count(DISTINCT v.parcelle_id)::int AS biens_imposes,
              sum(v.montant_theorique) AS potentiel,
              coalesce(sum(v.montant_liquide), 0) AS liquide,
              sum(v.montant_paye) AS recouvre,
              sum(v.montant_theorique) - sum(v.montant_paye) AS ecart,
              CASE WHEN sum(v.montant_liquide) > 0 THEN round(100 * sum(v.montant_paye) / sum(v.montant_liquide), 1) END AS taux_recouvrement
         FROM snifi.v_dossier_fiscal v JOIN snifi.parcelles p ON p.id = v.parcelle_id JOIN snifi.territoires t ON t.code = p.commune_code
        WHERE ($1::int IS NULL OR v.exercice = $1) AND ${filtreTerritoire(u, 'p.commune_code', params)}
        GROUP BY p.commune_code, t.nom, v.exercice ORDER BY v.exercice DESC, t.nom`, params);
  }
}
