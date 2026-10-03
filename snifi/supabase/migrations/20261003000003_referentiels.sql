-- SNIFI — Migration 003 : référentiels de base

SET search_path = snifi, public, extensions;

INSERT INTO sources_donnees (code, libelle, officielle, fiabilite) VALUES
  ('CADASTRE',    'Cadastre / service foncier',      true,  5),
  ('URBANISME',   'Urbanisme — permis de construire', true,  4),
  ('NOTAIRE',     'Actes notariés',                   true,  5),
  ('DECLARATION', 'Déclarations des contribuables',   false, 3),
  ('TERRAIN',     'Recensement / enquête terrain',    false, 3),
  ('COLLECTIVITE','Données des collectivités',        true,  3),
  ('SNIFI',       'Saisie directe SNIFI',             false, 3),
  ('IMPORT',      'Import Data Hub',                  false, 2);

-- Bibliothèque de règles d'anomalies (Module 08). Les paramètres sont modifiables sans code.
INSERT INTO regles_anomalies (code, libelle, description, gravite, poids, parametres) VALUES
  ('A001', 'Construction non référencée',
   'Un permis de construire existe pour la parcelle mais aucun bâtiment n''est enregistré dans le référentiel.',
   'elevee', 20, '{"delai_mois_apres_permis": 12}'),
  ('A002', 'Incohérence de superficie',
   'La superficie juridique de la parcelle diffère de la superficie calculée à partir de sa géométrie.',
   'moyenne', 15, '{"ecart_relatif_max": 0.10}'),
  ('A003', 'Mutation non actualisée',
   'Une transaction validée n''a pas été répercutée dans les droits : l''acquéreur ne détient aucun droit actif sur la parcelle.',
   'elevee', 20, '{"delai_jours": 30}'),
  ('A004', 'Incohérence déclarative',
   'La surface bâtie déclarée est inférieure à la surface bâtie connue dans le référentiel.',
   'elevee', 20, '{"ecart_relatif_max": 0.15}'),
  ('A005', 'Valeur atypique',
   'La valeur au m² d''une transaction s''écarte fortement de la médiane observée dans la même commune.',
   'moyenne', 15, '{"facteur_bas": 0.5, "facteur_haut": 2.0, "min_transactions": 3}'),
  ('A006', 'Bien non actualisé',
   'Les données de la parcelle n''ont pas été mises à jour depuis longtemps et nécessitent une vérification.',
   'faible', 10, '{"anciennete_annees": 5}');
