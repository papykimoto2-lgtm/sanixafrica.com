import { Controller, Get } from '@nestjs/common';
import { Roles, Utilisateur } from '../common/auth';
import { UtilisateurCourant } from '../common/roles';
import { DbService } from '../db/db.service';

/** Consultation par un propriétaire de ses seules données. */
@Controller('espace-proprietaire')
export class EspaceProprietaireController {
  constructor(private readonly db: DbService) {}

  @Roles('proprietaire')
  @Get('biens')
  biens(@Utilisateur() u: UtilisateurCourant) {
    return this.db.query(
      `SELECT p.id, p.snifi_id, p.commune_code, p.quartier, p.superficie_m2, d.type_droit, d.quote_part, d.date_debut,
              (SELECT json_agg(v ORDER BY v.exercice DESC) FROM snifi.v_dossier_fiscal v
                WHERE v.parcelle_id = p.id AND v.proprietaire_id = $1) AS fiscalite
         FROM snifi.droits d JOIN snifi.parcelles p ON p.id = d.parcelle_id
        WHERE d.proprietaire_id = $1 AND d.date_fin IS NULL`, [u.proprietaire_id]);
  }
}
