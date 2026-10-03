import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Audit, Roles } from '../common/auth';
import { ECRITURE, LECTURE } from '../common/roles';
import { dateIso, motifObligatoire, polygoneGeoJSON, setClause, uuid, Valider } from '../common/validation';
import { AuditContext, DbService } from '../db/db.service';

const USAGES = ['habitation', 'commercial', 'mixte', 'bureau', 'industriel', 'public', 'autre'] as const;

const batiment = z.object({
  parcelle_id: uuid,
  geometrie: polygoneGeoJSON.optional(),
  usage: z.enum(USAGES).default('habitation'),
  surface_m2: z.number().positive().optional(),
  nb_niveaux: z.number().int().min(1).default(1),
  nb_logements: z.number().int().min(0).default(0),
  etat: z.enum(['neuf', 'bon', 'moyen', 'degrade', 'ruine', 'en_construction']).optional(),
  annee_construction: z.number().int().min(1800).max(2100).optional(),
  valeur_estimative: z.number().nonnegative().optional(),
  statut_fiscal: z.enum(['a_evaluer', 'imposable', 'exonere', 'non_imposable']).default('a_evaluer'),
  source_code: z.string().default('SNIFI'),
  date_source: dateIso.optional(),
});
const modifBatiment = batiment.omit({ parcelle_id: true, geometrie: true }).partial().extend({ motif: motifObligatoire });
const unite = z.object({
  niveau: z.number().int().default(0),
  numero: z.string().optional(),
  type: z.enum(['logement', 'local_commercial', 'bureau', 'entrepot', 'autre']).default('logement'),
  usage: z.enum(USAGES).default('habitation'),
  surface_m2: z.number().positive().optional(),
  valeur_locative: z.number().nonnegative().optional(),
  occupation: z.enum(['proprietaire', 'locataire', 'vacant', 'inconnu']).optional(),
});
const permis = z.object({
  numero: z.string().trim().min(2),
  parcelle_id: uuid,
  date_delivrance: dateIso,
  surface_autorisee_m2: z.number().positive().optional(),
  nb_niveaux: z.number().int().min(1).optional(),
  usage: z.string().optional(),
});

const CHAMPS = ['usage', 'surface_m2', 'nb_niveaux', 'nb_logements', 'etat', 'annee_construction', 'valeur_estimative',
  'statut_fiscal', 'source_code', 'date_source'];

@Controller()
export class BatimentsController {
  constructor(private readonly db: DbService) {}

  @Roles(...LECTURE)
  @Get('batiments/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    const b = await this.db.one(
      `SELECT b.*, ST_AsGeoJSON(b.geom)::json AS geom, p.snifi_id AS parcelle_snifi_id
         FROM snifi.batiments b JOIN snifi.parcelles p ON p.id = b.parcelle_id WHERE b.id = $1`, [id]);
    if (!b) throw new NotFoundException('Bâtiment introuvable');
    const unites = await this.db.query('SELECT * FROM snifi.unites WHERE batiment_id = $1 ORDER BY niveau, numero', [id]);
    return { ...b, unites };
  }

  @Roles(...ECRITURE.batiments)
  @Post('batiments')
  creer(@Body(new Valider(batiment)) b: z.infer<typeof batiment>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO snifi.batiments (parcelle_id, geom, usage, surface_m2, nb_niveaux, nb_logements, etat, annee_construction,
                                      valeur_estimative, statut_fiscal, source_code, date_source)
         VALUES ($1, CASE WHEN $2::text IS NULL THEN NULL ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)) END,
                 $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, snifi_id, parcelle_id`,
        [b.parcelle_id, b.geometrie ? JSON.stringify(b.geometrie) : null, b.usage, b.surface_m2, b.nb_niveaux, b.nb_logements,
         b.etat, b.annee_construction, b.valeur_estimative, b.statut_fiscal, b.source_code, b.date_source]);
      return r.rows[0];
    });
  }

  @Roles(...ECRITURE.batiments)
  @Patch('batiments/:id')
  modifier(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(modifBatiment)) b: z.infer<typeof modifBatiment>, @Audit() ctx: AuditContext) {
    const set = setClause(b, CHAMPS, 2);
    if (set.vide) throw new BadRequestException('Aucun champ à modifier');
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(`UPDATE snifi.batiments SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.valeurs]);
      if (!r.rowCount) throw new NotFoundException('Bâtiment introuvable');
      return r.rows[0];
    });
  }

  @Roles(...ECRITURE.batiments)
  @Post('batiments/:id/unites')
  ajouterUnite(@Param('id', ParseUUIDPipe) id: string, @Body(new Valider(unite)) u: z.infer<typeof unite>, @Audit() ctx: AuditContext) {
    return this.db.tx(ctx, async (c) => {
      const r = await c.query(
        `INSERT INTO snifi.unites (batiment_id, niveau, numero, type, usage, surface_m2, valeur_locative, occupation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, u.niveau, u.numero, u.type, u.usage, u.surface_m2, u.valeur_locative, u.occupation]);
      return r.rows[0];
    });
  }

  @Roles(...ECRITURE.permis)
  @Post('permis')
  creerPermis(@Body(new Valider(permis)) p: z.infer<typeof permis>, @Audit() ctx: AuditContext) {
    return this.db.tx({ ...ctx, source: 'URBANISME' }, async (c) => {
      const r = await c.query(
        `INSERT INTO snifi.permis (numero, parcelle_id, date_delivrance, surface_autorisee_m2, nb_niveaux, usage)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [p.numero, p.parcelle_id, p.date_delivrance, p.surface_autorisee_m2, p.nb_niveaux, p.usage]);
      return r.rows[0];
    });
  }
}
