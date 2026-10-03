import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Audit, Roles, Utilisateur } from '../common/auth';
import { ECRITURE, LECTURE, UtilisateurCourant } from '../common/roles';
import { filtreTerritoire } from '../common/territoire';
import { dateIso, motifObligatoire, offset, pagination, polygoneGeoJSON, uuid, Valider } from '../common/validation';
import { AuditContext, DbService } from '../db/db.service';

const creation = z.object({
  commune_code: z.string().min(2),
  ref_cadastrale: z.string().trim().optional(),
  titre_foncier: z.string().trim().optional(),
  quartier: z.string().trim().optional(),
  superficie_m2: z.number().positive().optional(),
  geometrie: polygoneGeoJSON.optional(),
  source_code: z.string().default('SNIFI'),
  date_source: dateIso.optional(),
  proprietaire_id: uuid.optional(),       // premier droit de propriété
});
const modification = creation.omit({ proprietaire_id: true, commune_code: true }).partial().extend({
  statut: z.enum(['actif', 'subdivise', 'regroupe', 'litige', 'archive']).optional(),
  motif: motifObligatoire,
});
const droit = z.object({
  proprietaire_id: uuid,
  type_droit: z.enum(['propriete', 'copropriete', 'usufruit', 'nue_propriete', 'bail_emphyteotique', 'concession', 'attestation_villageoise', 'autre']).default('propriete'),
  quote_part: z.number().gt(0).max(1).default(1),
  date_debut: dateIso.optional(),
  document_ref: z.string().optional(),
  source_code: z.string().default('SNIFI'),
});
const recherche = pagination.extend({
  q: z.string().trim().optional(),
  commune: z.string().optional(),
  proprietaire: z.string().trim().optional(),
});

const COLONNES = `p.id, p.snifi_id, p.ref_cadastrale, p.titre_foncier, p.commune_code, t.nom AS commune, p.quartier,
  p.superficie_m2, p.superficie_geom_m2, p.statut, p.source_code, p.date_source, p.cree_le, p.modifie_le`;

@Controller('parcelles')
export class ParcellesController {
  constructor(private readonly db: DbService) {}

  @Roles(...LECTURE)
  @Get()
  async lister(@Query(new Valider(recherche)) q: z.infer<typeof recherche>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [];
    const where = [filtreTerritoire(u, 'p.commune_code', params)];
    if (q.q) {
      params.push(`%${q.q}%`);
      const n = params.length;
      where.push(`(p.snifi_id ILIKE $${n} OR p.ref_cadastrale ILIKE $${n} OR p.titre_foncier ILIKE $${n} OR p.quartier ILIKE $${n})`);
    }
    if (q.commune) { params.push(q.commune); where.push(`p.commune_code = $${params.length}`); }
    if (q.proprietaire) {
      params.push(`%${q.proprietaire}%`);
      where.push(`EXISTS (SELECT 1 FROM snifi.droits d JOIN snifi.proprietaires o ON o.id = d.proprietaire_id
                    WHERE d.parcelle_id = p.id AND d.date_fin IS NULL AND (o.nom ILIKE $${params.length} OR o.snifi_id ILIKE $${params.length}))`);
    }
    params.push(q.taille, offset(q));
    const rows = await this.db.query(
      `SELECT ${COLONNES},
              (SELECT string_agg(o.nom, ', ') FROM snifi.droits d JOIN snifi.proprietaires o ON o.id = d.proprietaire_id
                WHERE d.parcelle_id = p.id AND d.date_fin IS NULL) AS proprietaires,
              (SELECT count(*) FROM snifi.batiments b WHERE b.parcelle_id = p.id)::int AS nb_batiments,
              (SELECT count(*) FROM snifi.anomalies a WHERE a.parcelle_id = p.id AND a.statut IN ('ouverte', 'en_examen'))::int AS nb_anomalies,
              count(*) OVER ()::int AS total
         FROM snifi.parcelles p JOIN snifi.territoires t ON t.code = p.commune_code
        WHERE ${where.join(' AND ')}
        ORDER BY p.snifi_id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: rows[0]?.total ?? 0, page: q.page, elements: rows.map(({ total, ...r }) => r) };
  }

  @Roles(...LECTURE)
  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [id];
    const p = await this.db.one(
      `SELECT ${COLONNES}, ST_AsGeoJSON(p.geom)::json AS geometrie,
              json_build_object('source', s.libelle, 'officielle', s.officielle, 'fiabilite', s.fiabilite, 'date', p.date_source,
                                'actualite_jours', current_date - p.date_source) AS qualite
         FROM snifi.parcelles p JOIN snifi.territoires t ON t.code = p.commune_code
         LEFT JOIN snifi.sources_donnees s ON s.code = p.source_code
        WHERE p.id = $1 AND ${filtreTerritoire(u, 'p.commune_code', params)}`,
      params,
    );
    if (!p) throw new NotFoundException('Parcelle introuvable');
    const [droits, batiments, permis, transactions, anomalies] = await Promise.all([
      this.db.query(
        `SELECT d.*, o.nom, o.snifi_id AS proprietaire_snifi_id, o.type AS proprietaire_type
           FROM snifi.droits d JOIN snifi.proprietaires o ON o.id = d.proprietaire_id
          WHERE d.parcelle_id = $1 ORDER BY d.date_fin NULLS FIRST, d.date_debut DESC`, [id]),
      this.db.query(
        `SELECT b.*, ST_AsGeoJSON(b.geom)::json AS geom,
                (SELECT count(*) FROM snifi.unites un WHERE un.batiment_id = b.id)::int AS nb_unites,
                (SELECT sum(un.valeur_locative) FROM snifi.unites un WHERE un.batiment_id = b.id) AS valeur_locative_totale
           FROM snifi.batiments b WHERE b.parcelle_id = $1 ORDER BY b.snifi_id`, [id]),
      this.db.query('SELECT * FROM snifi.permis WHERE parcelle_id = $1 ORDER BY date_delivrance DESC', [id]),
      this.db.query(
        `SELECT t.*, c.nom AS cedant, a.nom AS acquereur FROM snifi.transactions t
           LEFT JOIN snifi.proprietaires c ON c.id = t.cedant_id LEFT JOIN snifi.proprietaires a ON a.id = t.acquereur_id
          WHERE t.parcelle_id = $1 ORDER BY t.date_evenement DESC`, [id]),
      this.db.query(
        `SELECT a.*, r.libelle FROM snifi.anomalies a JOIN snifi.regles_anomalies r ON r.code = a.regle_code
          WHERE a.parcelle_id = $1 ORDER BY a.detectee_le DESC`, [id]),
    ]);
    return { ...p, droits, batiments, permis, transactions, anomalies };
  }

  /** Historique complet des modifications de la parcelle et des objets rattachés. */
  @Roles(...LECTURE)
  @Get(':id/historique')
  historique(@Param('id', ParseUUIDPipe) id: string) {
    return this.db.query(
      `SELECT id, horodatage, utilisateur, action, table_nom, ligne_id, champs, avant, apres, motif, source
         FROM snifi.journal_audit WHERE parcelle_ref = $1::text
        ORDER BY id DESC LIMIT 500`,
      [id],
    );
  }

  @Roles(...ECRITURE.parcelles)
  @Post()
  creer(@Body(new Valider(creation)) b: z.infer<typeof creation>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO snifi.parcelles (commune_code, ref_cadastrale, titre_foncier, quartier, superficie_m2, geom, source_code, date_source)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)) END, $7, $8)
         RETURNING id, snifi_id, superficie_geom_m2, ST_IsValid(geom) AS geometrie_valide`,
        [b.commune_code, b.ref_cadastrale, b.titre_foncier, b.quartier, b.superficie_m2,
         b.geometrie ? JSON.stringify(b.geometrie) : null, b.source_code, b.date_source],
      );
      const p = r.rows[0];
      if (p.geometrie_valide === false) throw new BadRequestException('Géométrie invalide (auto-intersection, anneau ouvert…)');
      if (b.proprietaire_id) {
        await c.query(
          `INSERT INTO snifi.droits (proprietaire_id, parcelle_id, source_code) VALUES ($1, $2, $3)`,
          [b.proprietaire_id, p.id, b.source_code],
        );
      }
      return p;
    });
  }

  @Roles(...ECRITURE.parcelles)
  @Patch(':id')
  modifier(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(modification)) b: z.infer<typeof modification>, @Audit() ctx: AuditContext) {
    const champs: string[] = [];
    const valeurs: unknown[] = [id];
    for (const k of ['ref_cadastrale', 'titre_foncier', 'quartier', 'superficie_m2', 'source_code', 'date_source', 'statut'] as const) {
      if (b[k] !== undefined) { valeurs.push(b[k]); champs.push(`${k} = $${valeurs.length}`); }
    }
    if (b.geometrie) {
      valeurs.push(JSON.stringify(b.geometrie));
      champs.push(`geom = ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${valeurs.length}), 4326))`);
    }
    if (!champs.length) throw new BadRequestException('Aucun champ à modifier');
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `UPDATE snifi.parcelles SET ${champs.join(', ')} WHERE id = $1 RETURNING id, snifi_id, superficie_m2, superficie_geom_m2, statut`, valeurs);
      if (!r.rowCount) throw new NotFoundException('Parcelle introuvable');
      return r.rows[0];
    });
  }

  @Roles(...ECRITURE.parcelles)
  @Post(':id/droits')
  ajouterDroit(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(droit)) b: z.infer<typeof droit>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const total = await c.query(
        'SELECT coalesce(sum(quote_part), 0) AS s FROM snifi.droits WHERE parcelle_id = $1 AND date_fin IS NULL AND type_droit = $2',
        [id, b.type_droit]);
      if (Number(total.rows[0].s) + b.quote_part > 1.0001) {
        throw new BadRequestException('La somme des quotes-parts actives dépasserait 100 %');
      }
      const r = await c.query(
        `INSERT INTO snifi.droits (proprietaire_id, parcelle_id, type_droit, quote_part, date_debut, document_ref, source_code)
         VALUES ($1, $2, $3, $4, coalesce($5::date, current_date), $6, $7) RETURNING *`,
        [b.proprietaire_id, id, b.type_droit, b.quote_part, b.date_debut, b.document_ref, b.source_code]);
      return r.rows[0];
    });
  }
}
