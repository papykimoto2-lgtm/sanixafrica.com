import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles, Utilisateur } from '../common/auth';
import { LECTURE, UtilisateurCourant } from '../common/roles';
import { filtreTerritoire } from '../common/territoire';
import { Valider } from '../common/validation';
import { DbService } from '../db/db.service';

const filtre = z.object({ exercice: z.coerce.number().int().optional() });

@Controller('tableau-de-bord')
export class TableauDeBordController {
  constructor(private readonly db: DbService) {}

  @Roles(...LECTURE)
  @Get()
  async national(@Query(new Valider(filtre)) q: z.infer<typeof filtre>, @Utilisateur() u: UtilisateurCourant) {
    const params: unknown[] = [];
    const t = filtreTerritoire(u, 'p.commune_code', params);
    params.push(q.exercice ?? new Date().getFullYear());
    const ex = `$${params.length}`;
    const indicateurs = await this.db.one(
      `SELECT
         (SELECT count(*) FROM snifi.parcelles p WHERE ${t})::int AS parcelles,
         (SELECT count(*) FROM snifi.batiments b JOIN snifi.parcelles p ON p.id = b.parcelle_id WHERE ${t})::int AS batiments,
         (SELECT count(*) FROM snifi.unites un JOIN snifi.batiments b ON b.id = un.batiment_id JOIN snifi.parcelles p ON p.id = b.parcelle_id WHERE ${t})::int AS unites,
         (SELECT count(DISTINCT d.proprietaire_id) FROM snifi.droits d JOIN snifi.parcelles p ON p.id = d.parcelle_id WHERE d.date_fin IS NULL AND ${t})::int AS proprietaires,
         (SELECT count(DISTINCT i.parcelle_id) FROM snifi.impositions i JOIN snifi.parcelles p ON p.id = i.parcelle_id WHERE i.exercice = ${ex} AND ${t})::int AS biens_imposables,
         (SELECT coalesce(sum(v.montant_theorique), 0) FROM snifi.v_dossier_fiscal v JOIN snifi.parcelles p ON p.id = v.parcelle_id WHERE v.exercice = ${ex} AND ${t}) AS potentiel,
         (SELECT coalesce(sum(v.montant_liquide), 0) FROM snifi.v_dossier_fiscal v JOIN snifi.parcelles p ON p.id = v.parcelle_id WHERE v.exercice = ${ex} AND ${t}) AS liquide,
         (SELECT coalesce(sum(v.montant_paye), 0) FROM snifi.v_dossier_fiscal v JOIN snifi.parcelles p ON p.id = v.parcelle_id WHERE v.exercice = ${ex} AND ${t}) AS recouvre,
         (SELECT coalesce(sum(v.solde), 0) FROM snifi.v_dossier_fiscal v JOIN snifi.parcelles p ON p.id = v.parcelle_id
           WHERE v.prochaine_echeance < current_date AND v.solde > 0 AND ${t}) AS arrieres,
         (SELECT count(*) FROM snifi.anomalies a JOIN snifi.parcelles p ON p.id = a.parcelle_id WHERE a.statut IN ('ouverte', 'en_examen') AND ${t})::int AS anomalies_ouvertes`,
      params);
    const [anomalies, communes, usages] = await Promise.all([
      this.db.query(
        `SELECT r.code, r.libelle, r.gravite, count(a.id)::int AS ouvertes
           FROM snifi.regles_anomalies r
           LEFT JOIN (snifi.anomalies a JOIN snifi.parcelles p ON p.id = a.parcelle_id)
                  ON a.regle_code = r.code AND a.statut IN ('ouverte', 'en_examen') AND ${t}
          GROUP BY r.code, r.libelle, r.gravite ORDER BY r.code`, params.slice(0, -1)),
      this.db.query(
        `SELECT p.commune_code, tr.nom, count(*)::int AS parcelles,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM snifi.batiments b WHERE b.parcelle_id = p.id))::int AS parcelles_baties,
                (SELECT count(*) FROM snifi.anomalies a JOIN snifi.parcelles p2 ON p2.id = a.parcelle_id
                  WHERE p2.commune_code = p.commune_code AND a.statut IN ('ouverte', 'en_examen'))::int AS anomalies
           FROM snifi.parcelles p JOIN snifi.territoires tr ON tr.code = p.commune_code WHERE ${t}
          GROUP BY p.commune_code, tr.nom ORDER BY tr.nom`, params.slice(0, -1)),
      this.db.query(
        `SELECT b.usage, count(*)::int AS batiments, sum(b.surface_m2) AS surface_m2
           FROM snifi.batiments b JOIN snifi.parcelles p ON p.id = b.parcelle_id WHERE ${t}
          GROUP BY b.usage ORDER BY 2 DESC`, params.slice(0, -1)),
    ]);
    return { exercice: params[params.length - 1], indicateurs, anomalies, communes, usages };
  }
}
