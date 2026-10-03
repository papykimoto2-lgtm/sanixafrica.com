import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Audit, Roles, Utilisateur } from '../common/auth';
import { ECRITURE, LECTURE, UtilisateurCourant } from '../common/roles';
import { filtreTerritoire } from '../common/territoire';
import { motifObligatoire, offset, pagination, Valider } from '../common/validation';
import { AuditContext, DbService } from '../db/db.service';
import { REGLES, requeteExecution } from './moteur';

const STATUTS = ['ouverte', 'en_examen', 'confirmee', 'rejetee', 'corrigee', 'cloturee'] as const;
/** Cycle de traitement autorisé — une anomalie clôturée ne peut pas être rouverte silencieusement. */
const TRANSITIONS: Record<string, string[]> = {
  ouverte: ['en_examen', 'rejetee'],
  en_examen: ['confirmee', 'rejetee', 'corrigee'],
  confirmee: ['cloturee'],
  rejetee: ['cloturee'],
  corrigee: ['cloturee'],
  cloturee: [],
};

const recherche = pagination.extend({
  statut: z.enum(STATUTS).optional(),
  regle: z.string().optional(),
  gravite: z.enum(['faible', 'moyenne', 'elevee']).optional(),
  commune: z.string().optional(),
});
const execution = z.object({ regles: z.array(z.string()).optional() });
const traitement = z.object({ statut: z.enum(STATUTS), motif: motifObligatoire });
const regleModif = z.object({
  actif: z.boolean().optional(),
  poids: z.number().int().min(0).max(100).optional(),
  parametres: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  motif: motifObligatoire,
});

@Controller('anomalies')
export class AnomaliesController {
  constructor(private readonly db: DbService) {}

  @Roles(...LECTURE)
  @Get('regles')
  regles() {
    return this.db.query(
      `SELECT r.*, (SELECT count(*) FROM snifi.anomalies a WHERE a.regle_code = r.code AND a.statut IN ('ouverte', 'en_examen'))::int AS ouvertes
         FROM snifi.regles_anomalies r ORDER BY r.code`);
  }

  @Roles(...ECRITURE.reglesAnomalies)
  @Patch('regles/:code')
  modifierRegle(@Param('code') code: string, @Body(new Valider(regleModif)) b: z.infer<typeof regleModif>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `UPDATE snifi.regles_anomalies SET actif = coalesce($2, actif), poids = coalesce($3, poids),
                parametres = parametres || coalesce($4::jsonb, '{}') WHERE code = $1 RETURNING *`,
        [code, b.actif, b.poids, b.parametres ? JSON.stringify(b.parametres) : null]);
      if (!r.rowCount) throw new NotFoundException('Règle introuvable');
      return r.rows[0];
    });
  }

  /** Exécute le moteur de rapprochement sur les règles actives (ou une sélection). */
  @Roles(...ECRITURE.anomaliesExecution)
  @Post('executer')
  executer(@Body(new Valider(execution)) b: z.infer<typeof execution>, @Audit() ctx: AuditContext) {
    return this.db.tx({ ...ctx, motif: "Exécution du moteur d'anomalies", source: 'MOTEUR-ANOMALIES' }, async (c) => {
      const regles = (await c.query('SELECT code, parametres FROM snifi.regles_anomalies WHERE actif ORDER BY code')).rows
        .filter((r) => !b.regles || b.regles.includes(r.code));
      const resultats = [];
      for (const r of regles) {
        const regle = REGLES[r.code];
        if (!regle) continue;
        const res = (await c.query(requeteExecution(regle), [r.code, ...regle.params(r.parametres)])).rows[0];
        resultats.push({ regle: r.code, ...res });
      }
      return { execute_le: new Date().toISOString(), resultats };
    });
  }

  @Roles(...LECTURE)
  @Get()
  async lister(@Query(new Valider(recherche)) q: z.infer<typeof recherche>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [];
    const where = [filtreTerritoire(u, 'p.commune_code', params)];
    for (const [col, val] of [['a.statut', q.statut], ['a.regle_code', q.regle], ['a.gravite', q.gravite], ['p.commune_code', q.commune]]) {
      if (val) { params.push(val); where.push(`${col} = $${params.length}`); }
    }
    params.push(q.taille, offset(q));
    const rows = await this.db.query(
      `SELECT a.*, r.libelle, p.snifi_id AS parcelle_snifi_id, p.commune_code, o.nom AS proprietaire,
              count(*) OVER ()::int AS total
         FROM snifi.anomalies a JOIN snifi.regles_anomalies r ON r.code = a.regle_code
         LEFT JOIN snifi.parcelles p ON p.id = a.parcelle_id LEFT JOIN snifi.proprietaires o ON o.id = a.proprietaire_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE a.gravite WHEN 'elevee' THEN 0 WHEN 'moyenne' THEN 1 ELSE 2 END, a.detectee_le DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return { total: rows[0]?.total ?? 0, page: q.page, elements: rows.map(({ total, ...r }) => r) };
  }

  @Roles(...ECRITURE.anomaliesTraitement)
  @Patch(':id')
  traiter(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(traitement)) b: z.infer<typeof traitement>,
          @Audit() ctx: AuditContext, @Utilisateur() u: UtilisateurCourant) {
    return this.db.tx(ctx, async (c) => {
      const a = (await c.query('SELECT statut FROM snifi.anomalies WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!a) throw new NotFoundException('Anomalie introuvable');
      if (!TRANSITIONS[a.statut].includes(b.statut)) {
        throw new BadRequestException(`Transition non autorisée : ${a.statut} → ${b.statut}`);
      }
      const r = await c.query(
        `UPDATE snifi.anomalies SET statut = $2, commentaire = $3, traitee_le = now(), traitee_par = $4 WHERE id = $1 RETURNING *`,
        [id, b.statut, b.motif, u.login]);
      return r.rows[0];
    });
  }
}
