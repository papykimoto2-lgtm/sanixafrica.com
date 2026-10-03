/**
 * Moteur de rapprochement et d'anomalies (Modules 07 / 08).
 *
 * Chaque règle est une requête de rapprochement entre sources qui renvoie les éléments
 * objectifs ayant déclenché le signal. Une anomalie N'EST PAS une qualification de fraude :
 * elle appelle une vérification par l'administration compétente.
 *
 * Colonnes attendues : cle, parcelle_id, batiment_id, proprietaire_id, details (jsonb).
 * Les seuils proviennent de snifi.regles_anomalies.parametres (paramétrables sans code).
 */
export interface RegleSQL {
  sql: string;
  params: (p: Record<string, any>) => unknown[];
}

const PROPRIETAIRE = (col: string) => `(SELECT d.proprietaire_id FROM snifi.droits d
  WHERE d.parcelle_id = ${col} AND d.date_fin IS NULL ORDER BY d.quote_part DESC, d.date_debut DESC LIMIT 1)`;

export const REGLES: Record<string, RegleSQL> = {
  // Construction non référencée : URBANISME (permis) × SNIFI (bâtiments)
  A001: {
    params: (p) => [p.delai_mois_apres_permis ?? 12],
    sql: `SELECT pe.numero AS cle, pe.parcelle_id, NULL::uuid AS batiment_id, ${PROPRIETAIRE('pe.parcelle_id')} AS proprietaire_id,
                 jsonb_build_object('sources', jsonb_build_array('URBANISME', 'SNIFI'), 'permis', pe.numero,
                   'date_delivrance', pe.date_delivrance, 'surface_autorisee_m2', pe.surface_autorisee_m2,
                   'batiments_enregistres', 0) AS details
            FROM snifi.permis pe
           WHERE pe.date_delivrance <= current_date - make_interval(months => $2::int)
             AND NOT EXISTS (SELECT 1 FROM snifi.batiments b WHERE b.parcelle_id = pe.parcelle_id)`,
  },
  // Incohérence de superficie : titre (juridique) × géométrie (cadastre)
  A002: {
    params: (p) => [p.ecart_relatif_max ?? 0.1],
    sql: `SELECT p.id::text AS cle, p.id AS parcelle_id, NULL::uuid AS batiment_id, ${PROPRIETAIRE('p.id')} AS proprietaire_id,
                 jsonb_build_object('sources', jsonb_build_array('TITRE', 'GEOMETRIE'),
                   'superficie_juridique_m2', p.superficie_m2, 'superficie_geometrique_m2', p.superficie_geom_m2,
                   'ecart_relatif', round(abs(p.superficie_m2 - p.superficie_geom_m2) / p.superficie_m2, 3)) AS details
            FROM snifi.parcelles p
           WHERE p.superficie_m2 > 0 AND p.superficie_geom_m2 > 0
             AND abs(p.superficie_m2 - p.superficie_geom_m2) / p.superficie_m2 > $2::numeric`,
  },
  // Mutation non actualisée : transaction validée × droits
  A003: {
    params: (p) => [p.delai_jours ?? 30],
    sql: `SELECT t.id::text AS cle, t.parcelle_id, NULL::uuid AS batiment_id, t.cedant_id AS proprietaire_id,
                 jsonb_build_object('sources', jsonb_build_array(t.source_code, 'SNIFI'), 'transaction_id', t.id,
                   'type', t.type, 'date_evenement', t.date_evenement, 'acquereur_id', t.acquereur_id,
                   'jours_depuis_evenement', current_date - t.date_evenement) AS details
            FROM snifi.transactions t
           WHERE t.statut = 'validee' AND t.acquereur_id IS NOT NULL
             AND t.type IN ('vente', 'acquisition', 'donation', 'succession', 'mutation', 'transfert_droits')
             AND t.date_evenement <= current_date - $2::int
             AND NOT EXISTS (SELECT 1 FROM snifi.droits d WHERE d.parcelle_id = t.parcelle_id
                               AND d.proprietaire_id = t.acquereur_id AND d.date_fin IS NULL)`,
  },
  // Incohérence déclarative : déclaration × bâtiments connus
  A004: {
    params: (p) => [p.ecart_relatif_max ?? 0.15],
    sql: `SELECT d.id::text AS cle, d.parcelle_id, NULL::uuid AS batiment_id, d.proprietaire_id,
                 jsonb_build_object('sources', jsonb_build_array('DECLARATION', 'REFERENTIEL'), 'exercice', d.exercice,
                   'surface_batie_declaree_m2', d.surface_batie_declaree, 'surface_batie_connue_m2', b.surface,
                   'ecart_relatif', round((b.surface - d.surface_batie_declaree) / b.surface, 3)) AS details
            FROM snifi.declarations d
            JOIN LATERAL (SELECT sum(surface_m2) AS surface FROM snifi.batiments WHERE parcelle_id = d.parcelle_id) b ON true
           WHERE d.surface_batie_declaree IS NOT NULL AND b.surface > 0
             AND d.surface_batie_declaree < b.surface * (1 - $2::numeric)`,
  },
  // Valeur atypique : valeur au m² × médiane communale
  A005: {
    params: (p) => [p.facteur_bas ?? 0.5, p.facteur_haut ?? 2, p.min_transactions ?? 3],
    sql: `WITH tx AS (
            SELECT t.*, p.commune_code, t.valeur / p.superficie_m2 AS valeur_m2
              FROM snifi.transactions t JOIN snifi.parcelles p ON p.id = t.parcelle_id
             WHERE t.statut <> 'annulee' AND t.valeur > 0 AND p.superficie_m2 > 0
               AND t.type IN ('vente', 'acquisition')
          ), med AS (
            SELECT commune_code, percentile_cont(0.5) WITHIN GROUP (ORDER BY valeur_m2) AS mediane, count(*) AS n
              FROM tx GROUP BY commune_code
          )
          SELECT tx.id::text AS cle, tx.parcelle_id, NULL::uuid AS batiment_id, tx.acquereur_id AS proprietaire_id,
                 jsonb_build_object('sources', jsonb_build_array(tx.source_code), 'transaction_id', tx.id,
                   'valeur', tx.valeur, 'valeur_m2', round(tx.valeur_m2), 'mediane_commune_m2', round(med.mediane::numeric),
                   'ratio', round((tx.valeur_m2 / med.mediane)::numeric, 2), 'transactions_comparees', med.n) AS details
            FROM tx JOIN med USING (commune_code)
           WHERE med.n >= $4::int AND (tx.valeur_m2 < med.mediane * $2::numeric OR tx.valeur_m2 > med.mediane * $3::numeric)`,
  },
  // Bien non actualisé : ancienneté de la donnée
  A006: {
    params: (p) => [p.anciennete_annees ?? 5],
    sql: `SELECT p.id::text AS cle, p.id AS parcelle_id, NULL::uuid AS batiment_id, ${PROPRIETAIRE('p.id')} AS proprietaire_id,
                 jsonb_build_object('sources', jsonb_build_array(p.source_code), 'date_source', p.date_source,
                   'anciennete_jours', current_date - coalesce(p.date_source, p.cree_le::date)) AS details
            FROM snifi.parcelles p
           WHERE p.statut = 'actif'
             AND coalesce(p.date_source, p.cree_le::date) < current_date - make_interval(years => $2::int)`,
  },
};

/**
 * Requête complète d'exécution d'une règle : insertion des nouveaux signaux (sans doublon
 * d'une anomalie encore ouverte) et passage en « corrigée » des signaux qui ne se reproduisent plus.
 * $1 = code de la règle, $2… = paramètres de la règle.
 */
export function requeteExecution(regle: RegleSQL) {
  return `
    WITH res AS (${regle.sql}),
    ins AS (
      INSERT INTO snifi.anomalies (regle_code, empreinte, parcelle_id, batiment_id, proprietaire_id, gravite, details)
      SELECT $1, $1 || ':' || res.cle, res.parcelle_id, res.batiment_id, res.proprietaire_id,
             (SELECT gravite FROM snifi.regles_anomalies WHERE code = $1), res.details
        FROM res
      ON CONFLICT (empreinte) WHERE statut IN ('ouverte', 'en_examen') DO NOTHING
      RETURNING id
    ),
    fix AS (
      UPDATE snifi.anomalies a
         SET statut = 'corrigee', traitee_le = now(), traitee_par = 'MOTEUR',
             commentaire = 'Condition non reproduite lors de la dernière exécution du moteur'
       WHERE a.regle_code = $1 AND a.statut = 'ouverte'
         AND a.empreinte NOT IN (SELECT $1 || ':' || cle FROM res)
      RETURNING id
    )
    SELECT (SELECT count(*) FROM res)::int AS detectees,
           (SELECT count(*) FROM ins)::int AS nouvelles,
           (SELECT count(*) FROM fix)::int AS corrigees`;
}
