-- SNIFI — Jeu de données de DÉMONSTRATION (fictif)
--
-- ⚠ Tous les noms, identifiants, montants et taux ci-dessous sont fictifs et servent
-- uniquement à illustrer le fonctionnement du prototype. Les taux fiscaux réels doivent
-- être paramétrés par l'administration compétente dans snifi.regles_fiscales.

SET search_path = snifi, public, extensions;
SELECT set_config('snifi.utilisateur', 'SEED', false),
       set_config('snifi.source', 'SEED-DEMO', false),
       set_config('snifi.motif', 'Initialisation du jeu de démonstration', false);

-- Territoires ---------------------------------------------------------------
INSERT INTO territoires (code, type, nom, parent_code, geom) VALUES
  ('CI',         'pays',     'Côte d''Ivoire (démo)', NULL, NULL),
  ('CI-ABJ',     'district', 'District d''Abidjan',   'CI', NULL),
  ('CI-ABJ-COC', 'commune',  'Cocody',                'CI-ABJ',
     ST_Multi(ST_MakeEnvelope(-3.9900, 5.3400, -3.9700, 5.3600, 4326))),
  ('CI-ABJ-YOP', 'commune',  'Yopougon',              'CI-ABJ',
     ST_Multi(ST_MakeEnvelope(-4.0900, 5.3300, -4.0700, 5.3500, 4326)));

-- Zones fiscales --------------------------------------------------------------
INSERT INTO zones_fiscales (code, libelle, coefficient, geom) VALUES
  ('Z1', 'Zone résidentielle haut standing (démo)', 1.30, ST_Multi(ST_MakeEnvelope(-3.9900, 5.3400, -3.9700, 5.3600, 4326))),
  ('Z2', 'Zone urbaine standard (démo)',            1.00, ST_Multi(ST_MakeEnvelope(-4.0900, 5.3300, -4.0700, 5.3500, 4326)));

-- Règles fiscales (valeurs fictives, paramétrables) -----------------------------
INSERT INTO regles_fiscales (code, libelle, impot, assiette, usage, taux, abattement, applique_zone, date_debut, reference_legale) VALUES
  ('IFB-HAB', 'Foncier bâti — habitation (démo)',  'foncier_bati',     'valeur_locative', 'habitation', 0.040000, 0.0, true,  '2020-01-01', 'Paramètre de démonstration'),
  ('IFB-COM', 'Foncier bâti — commercial (démo)',  'foncier_bati',     'valeur_locative', 'commercial', 0.045000, 0.0, true,  '2020-01-01', 'Paramètre de démonstration'),
  ('IFB-MIX', 'Foncier bâti — mixte (démo)',       'foncier_bati',     'valeur_locative', 'mixte',      0.042000, 0.0, true,  '2020-01-01', 'Paramètre de démonstration'),
  ('IFNB',    'Foncier non bâti (démo, par m²)',   'foncier_non_bati', 'surface_terrain', NULL,         50.000000, 0.0, true, '2020-01-01', 'Paramètre de démonstration');

-- Profils SNIFI des comptes de démonstration.
-- Les comptes eux-mêmes sont créés dans Supabase Auth (voir demo_auth_users.sql) :
-- seuls ceux qui existent déjà reçoivent un profil.
INSERT INTO profils (user_id, login, nom, role, territoire_code)
SELECT u.id, v.login, v.nom, v.role, v.territoire
  FROM (VALUES
    ('admin@snifi.demo',      'admin',      'Administrateur national (démo)', 'admin_national',  NULL),
    ('agent@snifi.demo',      'agent',      'Agent fiscal Cocody (démo)',     'agent_fiscal',    'CI-ABJ-COC'),
    ('controleur@snifi.demo', 'controleur', 'Contrôleur (démo)',              'controleur',      NULL),
    ('foncier@snifi.demo',    'foncier',    'Service foncier (démo)',         'service_foncier', NULL),
    ('auditeur@snifi.demo',   'auditeur',   'Auditeur (démo)',                'auditeur',        NULL)
  ) AS v (email, login, nom, role, territoire)
  JOIN auth.users u ON lower(u.email) = v.email
ON CONFLICT (user_id) DO NOTHING;

-- Propriétaires, parcelles, bâtiments, unités, droits, permis, déclarations ---------
DO $$
DECLARE
  noms text[] := ARRAY['KOUASSI Aya (fictif)', 'KONAN Yao (fictif)', 'TRAORE Mariam (fictif)', 'BAMBA Issa (fictif)',
                       'SCI Les Palmiers (fictif)', 'DIALLO Fatou (fictif)', 'N''GUESSAN Paul (fictif)', 'YAO Akissi (fictif)',
                       'SARL Lagune Immobilier (fictif)', 'Succession KOFFI (fictif)', 'COULIBALY Adama (fictif)', 'OUATTARA Salimata (fictif)'];
  types text[] := ARRAY['personne_physique', 'personne_physique', 'personne_physique', 'personne_physique',
                        'personne_morale', 'personne_physique', 'personne_physique', 'personne_physique',
                        'personne_morale', 'succession', 'personne_physique', 'personne_physique'];
  props uuid[] := '{}';
  pid uuid; parc uuid; bat uuid;
  i int; x float8; y float8; lon0 float8; lat0 float8; commune text; quartier text;
  geom geometry; aire numeric; usage_b text; surf numeric; vl numeric;
BEGIN
  FOR i IN 1 .. array_length(noms, 1) LOOP
    INSERT INTO proprietaires (identifiant_fiscal, type, nom, telephone, adresse, source_code, date_source)
    VALUES ('NCC-DEMO-' || lpad(i::text, 5, '0'), types[i], noms[i], '+225 07 00 00 ' || lpad(i::text, 2, '0'),
            'Abidjan (adresse fictive)', 'CADASTRE', date '2025-06-01')
    RETURNING id INTO pid;
    props := props || pid;
  END LOOP;

  FOR i IN 0 .. 35 LOOP
    IF i < 24 THEN
      commune := 'CI-ABJ-COC'; lon0 := -3.9880; lat0 := 5.3420; quartier := CASE WHEN i < 12 THEN 'Riviera (démo)' ELSE 'Angré (démo)' END;
      x := lon0 + (i % 6) * 0.00035; y := lat0 + (i / 6) * 0.00035;
    ELSE
      commune := 'CI-ABJ-YOP'; lon0 := -4.0880; lat0 := 5.3320; quartier := 'Niangon (démo)';
      x := lon0 + ((i - 24) % 4) * 0.00035; y := lat0 + ((i - 24) / 4) * 0.00035;
    END IF;
    geom := ST_Multi(ST_MakeEnvelope(x, y, x + 0.00025, y + 0.00027, 4326));
    aire := round(ST_Area(geom::geography)::numeric, 2);

    INSERT INTO parcelles (ref_cadastrale, titre_foncier, commune_code, quartier, superficie_m2, geom, source_code, date_source)
    VALUES ('CAD-' || right(commune, 3) || '-' || lpad(i::text, 4, '0'), 'TF-DEMO-' || (10000 + i), commune, quartier,
            -- A002 : superficie juridique incohérente sur certaines parcelles
            CASE WHEN i % 9 = 4 THEN round(aire * 1.40, 2) ELSE round(aire * (0.98 + (i % 3) * 0.01), 2) END,
            geom, 'CADASTRE',
            -- A006 : données anciennes
            CASE WHEN i % 8 = 0 THEN date '2017-05-10' ELSE date '2024-01-15' + i END)
    RETURNING id INTO parc;

    INSERT INTO droits (proprietaire_id, parcelle_id, type_droit, date_debut, document_ref, source_code)
    VALUES (props[1 + (i % array_length(props, 1))], parc, 'propriete', date '2015-01-01' + (i * 37), 'ACTE-DEMO-' || i, 'CADASTRE');

    -- A001 : permis sans bâtiment ; les autres parcelles (sauf terrains nus) reçoivent un bâtiment
    IF i % 7 = 3 THEN
      INSERT INTO permis (numero, parcelle_id, date_delivrance, surface_autorisee_m2, nb_niveaux, usage)
      VALUES ('PC-DEMO-' || lpad(i::text, 4, '0'), parc, date '2023-03-01', 320, 2, 'habitation');
    ELSIF i % 11 <> 10 THEN
      usage_b := CASE WHEN i % 5 = 0 THEN 'commercial' WHEN i % 6 = 1 THEN 'mixte' ELSE 'habitation' END;
      surf := 120 + (i % 6) * 45;
      INSERT INTO batiments (parcelle_id, geom, usage, surface_m2, nb_niveaux, nb_logements, etat, annee_construction,
                             valeur_estimative, statut_fiscal, source_code, date_source)
      VALUES (parc, ST_Multi(ST_MakeEnvelope(x + 0.00005, y + 0.00005, x + 0.00018, y + 0.00020, 4326)),
              usage_b, surf, 1 + (i % 3), 1 + (i % 4), 'bon', 2005 + (i % 18),
              surf * 450000, 'imposable', 'TERRAIN', date '2025-02-01')
      RETURNING id INTO bat;

      FOR j IN 1 .. 1 + (i % 4) LOOP
        vl := round((surf / (1 + (i % 4))) * CASE WHEN usage_b = 'commercial' THEN 36000 ELSE 24000 END, 0);
        INSERT INTO unites (batiment_id, niveau, numero, type, usage, surface_m2, valeur_locative, occupation)
        VALUES (bat, (j - 1) % (1 + (i % 3)), 'U' || j,
                CASE WHEN usage_b = 'commercial' THEN 'local_commercial' ELSE 'logement' END,
                usage_b, round(surf / (1 + (i % 4)), 2), vl,
                CASE WHEN j = 1 THEN 'proprietaire' ELSE 'locataire' END);
      END LOOP;

      -- Déclarations 2026 ; A004 : surface bâtie sous-déclarée sur certaines parcelles
      INSERT INTO declarations (proprietaire_id, parcelle_id, exercice, surface_batie_declaree, usage_declare, date_depot)
      VALUES (props[1 + (i % array_length(props, 1))], parc, 2026,
              CASE WHEN i % 5 = 2 THEN round(surf * 0.6, 2) ELSE surf END, usage_b, date '2026-03-15');
    END IF;
  END LOOP;
END $$;

-- Transactions -------------------------------------------------------------------
-- Ventes « normales » appliquées (droits à jour) + cas A003 (non répercutée) et A005 (valeur atypique)
DO $$
DECLARE
  r record; tx uuid; acq uuid; n int := 0;
BEGIN
  FOR r IN
    SELECT p.id, p.superficie_m2, d.proprietaire_id, d.id AS droit_id, row_number() OVER (ORDER BY p.snifi_id) AS rn
      FROM parcelles p JOIN droits d ON d.parcelle_id = p.id AND d.date_fin IS NULL
     WHERE p.commune_code = 'CI-ABJ-COC'
  LOOP
    n := r.rn;
    IF n % 4 <> 1 THEN CONTINUE; END IF;
    SELECT id INTO acq FROM proprietaires WHERE id <> r.proprietaire_id ORDER BY snifi_id OFFSET (n % 5) LIMIT 1;

    INSERT INTO transactions (type, parcelle_id, date_evenement, valeur, cedant_id, acquereur_id, acteur, document_ref, source_code, statut)
    VALUES ('vente', r.id, date '2025-09-01' + (n::int * 9),
            -- A005 : une vente à un prix au m² anormalement bas
            CASE WHEN n = 13 THEN round(r.superficie_m2 * 20000) ELSE round(r.superficie_m2 * (140000 + n * 2500)) END,
            r.proprietaire_id, acq, 'Office notarial (fictif)', 'NOT-DEMO-' || n, 'NOTAIRE', 'validee')
    RETURNING id INTO tx;

    -- A003 : la vente n°9 n'est pas répercutée dans les droits
    IF n <> 9 THEN
      UPDATE droits SET date_fin = date '2025-09-01' + (n::int * 9) WHERE id = r.droit_id;
      INSERT INTO droits (proprietaire_id, parcelle_id, type_droit, date_debut, transaction_id, document_ref, source_code)
      VALUES (acq, r.id, 'propriete', date '2025-09-01' + (n::int * 9), tx, 'NOT-DEMO-' || n, 'NOTAIRE');
      UPDATE transactions SET statut = 'appliquee', appliquee_le = now() WHERE id = tx;
    END IF;
  END LOOP;
END $$;

SELECT set_config('snifi.motif', '', false);
