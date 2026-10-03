-- SNIFI — Migration 004 : fonctions métier

SET search_path = snifi, public;

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
