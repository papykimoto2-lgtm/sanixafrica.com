import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Audit, Roles, Utilisateur } from '../common/auth';
import { ECRITURE, LECTURE, UtilisateurCourant } from '../common/roles';
import { motifObligatoire, offset, pagination, setClause, uuid, Valider } from '../common/validation';
import { AuditContext, DbService } from '../db/db.service';

const TYPES = ['personne_physique', 'personne_morale', 'copropriete', 'succession', 'etat', 'collectivite', 'autre'] as const;

const creation = z.object({
  identifiant_fiscal: z.string().trim().min(1).optional(),
  type: z.enum(TYPES),
  nom: z.string().trim().min(2),
  telephone: z.string().trim().optional(),
  email: z.string().email().optional(),
  adresse: z.string().trim().optional(),
  source_code: z.string().default('SNIFI'),
  date_source: z.string().optional(),
});
const modification = creation.partial().extend({ statut: z.enum(['actif', 'inactif']).optional(), motif: motifObligatoire });
const recherche = pagination.extend({ q: z.string().trim().optional(), type: z.enum(TYPES).optional() });
const fusion = z.object({ doublon_id: uuid, motif: motifObligatoire });

const CHAMPS = ['identifiant_fiscal', 'type', 'nom', 'telephone', 'email', 'adresse', 'source_code', 'date_source', 'statut'];

@Controller('proprietaires')
export class ProprietairesController {
  constructor(private readonly db: DbService) {}

  @Roles(...LECTURE)
  @Get()
  async lister(@Query(new Valider(recherche)) q: z.infer<typeof recherche>) {
    const params: unknown[] = [];
    const where: string[] = ["statut <> 'fusionne'"];
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(nom ILIKE $${params.length} OR snifi_id ILIKE $${params.length} OR identifiant_fiscal ILIKE $${params.length})`);
    }
    if (q.type) { params.push(q.type); where.push(`type = $${params.length}`); }
    params.push(q.taille, offset(q));
    const rows = await this.db.query(
      `SELECT p.*, (SELECT count(*) FROM snifi.droits d WHERE d.proprietaire_id = p.id AND d.date_fin IS NULL)::int AS nb_biens,
              count(*) OVER ()::int AS total
         FROM snifi.proprietaires p WHERE ${where.join(' AND ')}
        ORDER BY nom LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { total: rows[0]?.total ?? 0, page: q.page, elements: rows.map(({ total, ...r }) => r) };
  }

  @Roles(...LECTURE, 'proprietaire')
  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Utilisateur() u: UtilisateurCourant) {
    if (u.role === 'proprietaire' && u.proprietaire_id !== id) throw new NotFoundException();
    const p = await this.db.one('SELECT * FROM snifi.proprietaires WHERE id = $1', [id]);
    if (!p) throw new NotFoundException('Propriétaire introuvable');
    const biens = await this.db.query(
      `SELECT d.id AS droit_id, d.type_droit, d.quote_part, d.date_debut, d.date_fin,
              pa.id AS parcelle_id, pa.snifi_id, pa.commune_code, pa.quartier, pa.superficie_m2
         FROM snifi.droits d JOIN snifi.parcelles pa ON pa.id = d.parcelle_id
        WHERE d.proprietaire_id = $1 ORDER BY d.date_fin NULLS FIRST, d.date_debut DESC`,
      [id],
    );
    return { ...p, biens };
  }

  @Roles(...ECRITURE.proprietaires)
  @Post()
  creer(@Body(new Valider(creation)) body: z.infer<typeof creation>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO snifi.proprietaires (identifiant_fiscal, type, nom, telephone, email, adresse, source_code, date_source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [body.identifiant_fiscal, body.type, body.nom, body.telephone, body.email, body.adresse, body.source_code, body.date_source],
      );
      return r.rows[0];
    });
  }

  @Roles(...ECRITURE.proprietaires)
  @Patch(':id')
  modifier(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(modification)) body: z.infer<typeof modification>, @Audit() ctx: AuditContext) {
    const set = setClause(body, CHAMPS, 2);
    if (set.vide) throw new BadRequestException('Aucun champ à modifier');
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(`UPDATE snifi.proprietaires SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.valeurs]);
      if (!r.rowCount) throw new NotFoundException('Propriétaire introuvable');
      return r.rows[0];
    });
  }

  /** Fusion de doublons : les droits, déclarations et transactions du doublon sont rattachés au propriétaire conservé. */
  @Roles(...ECRITURE.proprietaires)
  @Post(':id/fusion')
  fusionner(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(fusion)) body: z.infer<typeof fusion>, @Audit() ctx: AuditContext) {
    if (id === body.doublon_id) throw new BadRequestException('Un propriétaire ne peut pas être fusionné avec lui-même');
    return this.db.tx(ctx, async (c) => {
      const ok = await c.query(
        "SELECT id FROM snifi.proprietaires WHERE id = ANY($1::uuid[]) AND statut <> 'fusionne'", [[id, body.doublon_id]]);
      if (ok.rowCount !== 2) throw new NotFoundException('Propriétaire(s) introuvable(s) ou déjà fusionné(s)');
      const d = await c.query('UPDATE snifi.droits SET proprietaire_id = $1 WHERE proprietaire_id = $2', [id, body.doublon_id]);
      await c.query('UPDATE snifi.declarations SET proprietaire_id = $1 WHERE proprietaire_id = $2', [id, body.doublon_id]);
      await c.query('UPDATE snifi.transactions SET cedant_id = $1 WHERE cedant_id = $2', [id, body.doublon_id]);
      await c.query('UPDATE snifi.transactions SET acquereur_id = $1 WHERE acquereur_id = $2', [id, body.doublon_id]);
      await c.query("UPDATE snifi.proprietaires SET statut = 'fusionne', fusionne_vers = $1 WHERE id = $2", [id, body.doublon_id]);
      return { conserve: id, fusionne: body.doublon_id, droits_rattaches: d.rowCount };
    });
  }
}
