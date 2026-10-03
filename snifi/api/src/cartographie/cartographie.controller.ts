import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, Utilisateur } from '../common/auth';
import { LECTURE, UtilisateurCourant } from '../common/roles';
import { filtreTerritoire } from '../common/territoire';
import { Valider } from '../common/validation';
import { DbService } from '../db/db.service';

/** bbox = ouest,sud,est,nord (WGS84) */
const emprise = z.object({
  bbox: z.string().regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'bbox attendu : ouest,sud,est,nord').optional(),
  commune: z.string().optional(),
});

function filtreBbox(bbox: string | undefined, col: string, params: unknown[]) {
  if (!bbox) return 'true';
  params.push(...bbox.split(',').map(Number));
  const n = params.length;
  return `${col} && ST_MakeEnvelope($${n - 3}, $${n - 2}, $${n - 1}, $${n}, 4326)`;
}

/** Couches cartographiques au format GeoJSON (consommées par MapLibre / OpenLayers). */
@Controller('cartographie')
export class CartographieController {
  constructor(private readonly db: DbService) {}

  private async collection(sql: string, params: unknown[]) {
    const r = await this.db.one(
      `SELECT json_build_object('type', 'FeatureCollection', 'features', coalesce(json_agg(f), '[]'::json)) AS fc FROM (${sql}) f`, params);
    return r.fc;
  }

  @Roles(...LECTURE)
  @Get('parcelles')
  parcelles(@Query(new Valider(emprise)) q: z.infer<typeof emprise>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [];
    const where = [filtreBbox(q.bbox, 'p.geom', params), filtreTerritoire(u, 'p.commune_code', params), 'p.geom IS NOT NULL'];
    if (q.commune) { params.push(q.commune); where.push(`p.commune_code = $${params.length}`); }
    return this.collection(
      `SELECT 'Feature' AS type, ST_AsGeoJSON(p.geom)::json AS geometry,
              json_build_object('id', p.id, 'snifi_id', p.snifi_id, 'quartier', p.quartier, 'commune', p.commune_code,
                'superficie_m2', p.superficie_m2, 'statut', p.statut,
                'nb_batiments', (SELECT count(*) FROM snifi.batiments b WHERE b.parcelle_id = p.id),
                'nb_anomalies', (SELECT count(*) FROM snifi.anomalies a WHERE a.parcelle_id = p.id AND a.statut IN ('ouverte', 'en_examen')),
                'proprietaires', (SELECT string_agg(o.nom, ', ') FROM snifi.droits d JOIN snifi.proprietaires o ON o.id = d.proprietaire_id
                                   WHERE d.parcelle_id = p.id AND d.date_fin IS NULL)) AS properties
         FROM snifi.parcelles p WHERE ${where.join(' AND ')} LIMIT 5000`, params);
  }

  @Roles(...LECTURE)
  @Get('batiments')
  batiments(@Query(new Valider(emprise)) q: z.infer<typeof emprise>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [];
    const where = [filtreBbox(q.bbox, 'b.geom', params), filtreTerritoire(u, 'p.commune_code', params), 'b.geom IS NOT NULL'];
    return this.collection(
      `SELECT 'Feature' AS type, ST_AsGeoJSON(b.geom)::json AS geometry,
              json_build_object('id', b.id, 'snifi_id', b.snifi_id, 'usage', b.usage, 'nb_niveaux', b.nb_niveaux,
                                'statut_fiscal', b.statut_fiscal, 'parcelle_id', b.parcelle_id) AS properties
         FROM snifi.batiments b JOIN snifi.parcelles p ON p.id = b.parcelle_id WHERE ${where.join(' AND ')} LIMIT 10000`, params);
  }

  @Roles(...LECTURE)
  @Get('zones-fiscales')
  zones() {
    return this.collection(
      `SELECT 'Feature' AS type, ST_AsGeoJSON(geom)::json AS geometry,
              json_build_object('code', code, 'libelle', libelle, 'coefficient', coefficient) AS properties
         FROM snifi.zones_fiscales WHERE geom IS NOT NULL`, []);
  }

  @Roles(...LECTURE)
  @Get('territoires')
  territoires() {
    return this.collection(
      `SELECT 'Feature' AS type, ST_AsGeoJSON(geom)::json AS geometry,
              json_build_object('code', code, 'nom', nom, 'type', type,
                                'centre', ST_AsGeoJSON(ST_PointOnSurface(geom))::json) AS properties
         FROM snifi.territoires WHERE geom IS NOT NULL`, []);
  }
}
