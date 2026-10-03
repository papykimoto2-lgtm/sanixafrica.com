-- SNIFI — Migration 004 : fonctions métier

SET search_path = snifi, public, extensions;

-- Calcul des impositions théoriques d'un exercice à partir des règles fiscales paramétrées.
-- Montant = base × (1 − abattement) × taux × coefficient de zone × (1 − exonération) × quote-part
-- Le détail de chaque facteur est conservé dans detail_calcul (explicabilité).
-- Les impositions déjà liquidées ne sont jamais recalculées.
CREATE FUNCTION calculer_impositions(p_exercice int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  d_ref date := make_date(p_exercice, 1, 1);      -- situation des droits au 1er janvier
  d_fin date := make_date(p_exercice, 12, 31);
  n int;
BEGIN
  WITH regles AS (
    SELECT * FROM snifi.regles_fiscales r
     WHERE r.actif AND r.date_debut <= d_fin AND (r.date_fin IS NULL OR r.date_fin >= d_ref)
  ), bases AS (
    SELECT p.id AS parcelle_id, r.id AS regle_id, r.code, r.impot, r.assiette, r.usage, r.taux, r.abattement,
           CASE r.assiette
             WHEN 'valeur_locative' THEN (
               SELECT sum(u.valeur_locative) FROM snifi.batiments b JOIN snifi.unites u ON u.batiment_id = b.id
                WHERE b.parcelle_id = p.id AND b.statut_fiscal = 'imposable' AND (r.usage IS NULL OR b.usage = r.usage))
             WHEN 'valeur_venale' THEN (
               SELECT sum(b.valeur_estimative) FROM snifi.batiments b
                WHERE b.parcelle_id = p.id AND b.statut_fiscal = 'imposable' AND (r.usage IS NULL OR b.usage = r.usage))
             WHEN 'surface_batie' THEN (
               SELECT sum(b.surface_m2) FROM snifi.batiments b
                WHERE b.parcelle_id = p.id AND b.statut_fiscal = 'imposable' AND (r.usage IS NULL OR b.usage = r.usage))
             WHEN 'surface_terrain' THEN
               CASE WHEN NOT EXISTS (SELECT 1 FROM snifi.batiments b WHERE b.parcelle_id = p.id) THEN p.superficie_m2 END
           END AS base,
           CASE WHEN r.applique_zone THEN coalesce((
             SELECT z.coefficient FROM snifi.zones_fiscales z
              WHERE p.geom IS NOT NULL AND ST_Contains(z.geom, ST_PointOnSurface(p.geom))
              ORDER BY z.coefficient DESC LIMIT 1), 1) ELSE 1 END AS coef,
           (SELECT z.code FROM snifi.zones_fiscales z
             WHERE p.geom IS NOT NULL AND ST_Contains(z.geom, ST_PointOnSurface(p.geom))
             ORDER BY z.coefficient DESC LIMIT 1) AS zone,
           coalesce((
             SELECT max(e.taux) FROM snifi.exonerations e
              WHERE e.parcelle_id = p.id AND (e.impot IS NULL OR e.impot = r.impot)
                AND e.date_debut <= d_fin AND (e.date_fin IS NULL OR e.date_fin >= d_ref)), 0) AS exo
      FROM snifi.parcelles p CROSS JOIN regles r
     WHERE p.statut IN ('actif', 'litige')
  )
  INSERT INTO snifi.impositions (parcelle_id, proprietaire_id, exercice, regle_id, base_imposable, montant_theorique, detail_calcul)
  SELECT b.parcelle_id, d.proprietaire_id, p_exercice, b.regle_id,
         round(b.base * d.quote_part, 2),
         round(b.base * (1 - b.abattement) * b.taux * b.coef * (1 - b.exo) * d.quote_part, 0),
         jsonb_build_object(
           'regle', b.code, 'impot', b.impot, 'assiette', b.assiette, 'usage', b.usage,
           'base', b.base, 'abattement', b.abattement, 'taux', b.taux,
           'zone', b.zone, 'coefficient_zone', b.coef, 'exoneration', b.exo,
           'quote_part', d.quote_part, 'droit_id', d.id, 'date_reference', d_ref,
           'formule', 'base × (1 − abattement) × taux × coefficient_zone × (1 − exoneration) × quote_part')
    FROM bases b
    JOIN snifi.droits d ON d.parcelle_id = b.parcelle_id
                       AND d.date_debut <= d_ref AND (d.date_fin IS NULL OR d.date_fin > d_ref)
   WHERE b.base > 0
  ON CONFLICT (parcelle_id, proprietaire_id, exercice, regle_id) DO UPDATE
     SET base_imposable = EXCLUDED.base_imposable,
         montant_theorique = EXCLUDED.montant_theorique,
         detail_calcul = EXCLUDED.detail_calcul,
         calcule_le = now()
   WHERE snifi.impositions.statut = 'calculee';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Synthèse du dossier fiscal par parcelle / propriétaire / exercice
CREATE VIEW v_dossier_fiscal AS
SELECT i.parcelle_id, i.proprietaire_id, i.exercice,
       sum(i.montant_theorique)                     AS montant_theorique,
       (SELECT sum(d.montant_declare) FROM snifi.declarations d
         WHERE d.parcelle_id = i.parcelle_id AND d.proprietaire_id = i.proprietaire_id AND d.exercice = i.exercice) AS montant_declare,
       sum(i.montant_liquide)                       AS montant_liquide,
       coalesce(sum(pa.paye), 0)                    AS montant_paye,
       coalesce(sum(i.montant_liquide), 0) - coalesce(sum(pa.paye), 0) AS solde,
       min(i.date_echeance)                         AS prochaine_echeance
  FROM snifi.impositions i
  LEFT JOIN LATERAL (SELECT sum(p.montant) AS paye FROM snifi.paiements p WHERE p.imposition_id = i.id) pa ON true
 WHERE i.statut <> 'annulee'
 GROUP BY i.parcelle_id, i.proprietaire_id, i.exercice;

-- ---------------------------------------------------------------------------
-- Moteur de rapprochement et d'anomalies (Modules 07 / 08)
-- Chaque règle croise des sources et renvoie les éléments objectifs du signal.
-- Une anomalie N'EST PAS une qualification de fraude.
-- ---------------------------------------------------------------------------
CREATE FUNCTION proprietaire_principal(p_parcelle uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT d.proprietaire_id FROM snifi.droits d
   WHERE d.parcelle_id = p_parcelle AND d.date_fin IS NULL
   ORDER BY d.quote_part DESC, d.date_debut DESC LIMIT 1
$$;

CREATE FUNCTION regle_anomalie_resultats(p_code text, p jsonb)
RETURNS TABLE (cle text, parcelle_id uuid, batiment_id uuid, proprietaire_id uuid, details jsonb)
LANGUAGE plpgsql STABLE AS $$
#variable_conflict use_column
BEGIN
  CASE p_code
  -- A001 Construction non référencée : URBANISME (permis) × SNIFI (bâtiments)
  WHEN 'A001' THEN RETURN QUERY
    SELECT pe.numero, pe.parcelle_id, NULL::uuid, snifi.proprietaire_principal(pe.parcelle_id),
           jsonb_build_object('sources', jsonb_build_array('URBANISME', 'SNIFI'), 'permis', pe.numero,
             'date_delivrance', pe.date_delivrance, 'surface_autorisee_m2', pe.surface_autorisee_m2, 'batiments_enregistres', 0)
      FROM snifi.permis pe
     WHERE pe.date_delivrance <= current_date - make_interval(months => coalesce((p ->> 'delai_mois_apres_permis')::int, 12))
       AND NOT EXISTS (SELECT 1 FROM snifi.batiments b WHERE b.parcelle_id = pe.parcelle_id);
  -- A002 Incohérence de superficie : titre × géométrie
  WHEN 'A002' THEN RETURN QUERY
    SELECT pa.id::text, pa.id, NULL::uuid, snifi.proprietaire_principal(pa.id),
           jsonb_build_object('sources', jsonb_build_array('TITRE', 'GEOMETRIE'),
             'superficie_juridique_m2', pa.superficie_m2, 'superficie_geometrique_m2', pa.superficie_geom_m2,
             'ecart_relatif', round(abs(pa.superficie_m2 - pa.superficie_geom_m2) / pa.superficie_m2, 3))
      FROM snifi.parcelles pa
     WHERE pa.superficie_m2 > 0 AND pa.superficie_geom_m2 > 0
       AND abs(pa.superficie_m2 - pa.superficie_geom_m2) / pa.superficie_m2 > coalesce((p ->> 'ecart_relatif_max')::numeric, 0.10);
  -- A003 Mutation non actualisée : transaction validée × droits
  WHEN 'A003' THEN RETURN QUERY
    SELECT t.id::text, t.parcelle_id, NULL::uuid, t.cedant_id,
           jsonb_build_object('sources', jsonb_build_array(t.source_code, 'SNIFI'), 'transaction_id', t.id,
             'type', t.type, 'date_evenement', t.date_evenement, 'acquereur_id', t.acquereur_id,
             'jours_depuis_evenement', current_date - t.date_evenement)
      FROM snifi.transactions t
     WHERE t.statut = 'validee' AND t.acquereur_id IS NOT NULL
       AND t.type IN ('vente', 'acquisition', 'donation', 'succession', 'mutation', 'transfert_droits')
       AND t.date_evenement <= current_date - coalesce((p ->> 'delai_jours')::int, 30)
       AND NOT EXISTS (SELECT 1 FROM snifi.droits d WHERE d.parcelle_id = t.parcelle_id
                         AND d.proprietaire_id = t.acquereur_id AND d.date_fin IS NULL);
  -- A004 Incohérence déclarative : déclaration × bâtiments connus
  WHEN 'A004' THEN RETURN QUERY
    SELECT d.id::text, d.parcelle_id, NULL::uuid, d.proprietaire_id,
           jsonb_build_object('sources', jsonb_build_array('DECLARATION', 'REFERENTIEL'), 'exercice', d.exercice,
             'surface_batie_declaree_m2', d.surface_batie_declaree, 'surface_batie_connue_m2', b.surface,
             'ecart_relatif', round((b.surface - d.surface_batie_declaree) / b.surface, 3))
      FROM snifi.declarations d
      JOIN LATERAL (SELECT sum(surface_m2) AS surface FROM snifi.batiments WHERE parcelle_id = d.parcelle_id) b ON true
     WHERE d.surface_batie_declaree IS NOT NULL AND b.surface > 0
       AND d.surface_batie_declaree < b.surface * (1 - coalesce((p ->> 'ecart_relatif_max')::numeric, 0.15));
  -- A005 Valeur atypique : prix au m² × médiane communale
  WHEN 'A005' THEN RETURN QUERY
    WITH tx AS (
      SELECT t.*, pa.commune_code, t.valeur / pa.superficie_m2 AS valeur_m2
        FROM snifi.transactions t JOIN snifi.parcelles pa ON pa.id = t.parcelle_id
       WHERE t.statut <> 'annulee' AND t.valeur > 0 AND pa.superficie_m2 > 0 AND t.type IN ('vente', 'acquisition')
    ), med AS (
      SELECT commune_code, percentile_cont(0.5) WITHIN GROUP (ORDER BY valeur_m2) AS mediane, count(*) AS n FROM tx GROUP BY commune_code
    )
    SELECT tx.id::text, tx.parcelle_id, NULL::uuid, tx.acquereur_id,
           jsonb_build_object('sources', jsonb_build_array(tx.source_code), 'transaction_id', tx.id,
             'valeur', tx.valeur, 'valeur_m2', round(tx.valeur_m2), 'mediane_commune_m2', round(med.mediane::numeric),
             'ratio', round((tx.valeur_m2 / med.mediane)::numeric, 2), 'transactions_comparees', med.n)
      FROM tx JOIN med USING (commune_code)
     WHERE med.n >= coalesce((p ->> 'min_transactions')::int, 3)
       AND (tx.valeur_m2 < med.mediane * coalesce((p ->> 'facteur_bas')::numeric, 0.5)
         OR tx.valeur_m2 > med.mediane * coalesce((p ->> 'facteur_haut')::numeric, 2));
  -- A006 Bien non actualisé : ancienneté de la donnée
  WHEN 'A006' THEN RETURN QUERY
    SELECT pa.id::text, pa.id, NULL::uuid, snifi.proprietaire_principal(pa.id),
           jsonb_build_object('sources', jsonb_build_array(pa.source_code), 'date_source', pa.date_source,
             'anciennete_jours', current_date - coalesce(pa.date_source, pa.cree_le::date))
      FROM snifi.parcelles pa
     WHERE pa.statut = 'actif'
       AND coalesce(pa.date_source, pa.cree_le::date) < current_date - make_interval(years => coalesce((p ->> 'anciennete_annees')::int, 5));
  ELSE RETURN;
  END CASE;
END $$;

-- Exécute une règle : insère les nouveaux signaux (sans doublon d'une anomalie encore ouverte)
-- et passe en « corrigée » les signaux ouverts qui ne se reproduisent plus.
CREATE FUNCTION executer_regle_anomalie(p_code text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r snifi.regles_anomalies;
  n_det int; n_new int; n_fix int;
BEGIN
  SELECT * INTO r FROM snifi.regles_anomalies WHERE code = p_code;
  WITH res AS (SELECT * FROM snifi.regle_anomalie_resultats(p_code, r.parametres)),
  ins AS (
    INSERT INTO snifi.anomalies (regle_code, empreinte, parcelle_id, batiment_id, proprietaire_id, gravite, details)
    SELECT p_code, p_code || ':' || res.cle, res.parcelle_id, res.batiment_id, res.proprietaire_id, r.gravite, res.details FROM res
    ON CONFLICT (empreinte) WHERE statut IN ('ouverte', 'en_examen') DO NOTHING
    RETURNING 1
  ),
  fix AS (
    UPDATE snifi.anomalies a
       SET statut = 'corrigee', traitee_le = now(), traitee_par = 'MOTEUR',
           commentaire = 'Condition non reproduite lors de la dernière exécution du moteur'
     WHERE a.regle_code = p_code AND a.statut = 'ouverte'
       AND a.empreinte NOT IN (SELECT p_code || ':' || cle FROM res)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM res), (SELECT count(*) FROM ins), (SELECT count(*) FROM fix) INTO n_det, n_new, n_fix;
  RETURN jsonb_build_object('regle', p_code, 'detectees', n_det, 'nouvelles', n_new, 'corrigees', n_fix);
END $$;
