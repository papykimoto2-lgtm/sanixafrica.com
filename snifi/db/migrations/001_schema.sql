-- SNIFI — Système National d'Intelligence Fiscale Immobilière
-- Migration 001 : modèle de données central (MVP V1)
--
-- PROPRIÉTAIRE → DROIT/TITRE → PARCELLE → BÂTIMENT → UNITÉ → (TRANSACTION, FISCALITÉ)

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS snifi;
SET search_path = snifi, public;

-- ---------------------------------------------------------------------------
-- 01. Utilisateurs / sécurité (RBAC, moindre privilège)
-- ---------------------------------------------------------------------------
CREATE TABLE utilisateurs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login           text NOT NULL UNIQUE,
  nom             text NOT NULL,
  mot_de_passe    text NOT NULL,             -- hash bcrypt, jamais en clair
  role            text NOT NULL CHECK (role IN (
                    'admin_national', 'admin_regional', 'agent_fiscal', 'controleur',
                    'collectivite', 'service_foncier', 'urbanisme', 'notaire',
                    'promoteur', 'proprietaire', 'auditeur', 'admin_technique')),
  territoire_code text,                       -- périmètre territorial (admin régional, collectivité)
  proprietaire_id uuid,                       -- rôle « propriétaire » : accès à ses seules données
  actif           boolean NOT NULL DEFAULT true,
  cree_le         timestamptz NOT NULL DEFAULT now(),
  derniere_connexion timestamptz
);

-- ---------------------------------------------------------------------------
-- Référentiel territorial (district > région > département > commune > quartier)
-- ---------------------------------------------------------------------------
CREATE TABLE territoires (
  code        text PRIMARY KEY,               -- ex. CI-ABJ-COC
  type        text NOT NULL CHECK (type IN ('pays', 'district', 'region', 'departement', 'commune', 'quartier')),
  nom         text NOT NULL,
  parent_code text REFERENCES territoires(code),
  geom        geometry(MultiPolygon, 4326)
);
CREATE INDEX territoires_geom_idx ON territoires USING gist (geom);

-- ---------------------------------------------------------------------------
-- Métadonnées qualité communes à chaque donnée (§23)
-- source, date, fiabilité, complétude, actualité, statut
-- ---------------------------------------------------------------------------
CREATE TABLE sources_donnees (
  code       text PRIMARY KEY,                -- CADASTRE, URBANISME, NOTAIRE, DECLARATION, TERRAIN, SNIFI…
  libelle    text NOT NULL,
  officielle boolean NOT NULL DEFAULT false,
  fiabilite  smallint NOT NULL DEFAULT 3 CHECK (fiabilite BETWEEN 1 AND 5)
);

-- ---------------------------------------------------------------------------
-- 02. Référentiel des propriétaires (Module 01)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE proprietaire_seq;

CREATE TABLE proprietaires (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snifi_id           text NOT NULL UNIQUE DEFAULT 'PROP-' || lpad(nextval('snifi.proprietaire_seq')::text, 9, '0'),
  identifiant_fiscal text UNIQUE,
  type               text NOT NULL CHECK (type IN (
                       'personne_physique', 'personne_morale', 'copropriete', 'succession',
                       'etat', 'collectivite', 'autre')),
  nom                text NOT NULL,           -- nom / raison sociale
  telephone          text,
  email              text,
  adresse            text,
  statut             text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'inactif', 'fusionne')),
  fusionne_vers      uuid REFERENCES proprietaires(id),
  source_code        text REFERENCES sources_donnees(code),
  date_source        date,
  cree_le            timestamptz NOT NULL DEFAULT now(),
  modifie_le         timestamptz NOT NULL DEFAULT now(),
  CHECK (statut <> 'fusionne' OR fusionne_vers IS NOT NULL)
);
CREATE INDEX proprietaires_nom_idx ON proprietaires USING gin (to_tsvector('simple', nom));

ALTER TABLE utilisateurs
  ADD CONSTRAINT utilisateurs_proprietaire_fk FOREIGN KEY (proprietaire_id) REFERENCES proprietaires(id);

-- ---------------------------------------------------------------------------
-- 03. Référentiel parcellaire (Module 02)
-- Identifiant Immobilier SNIFI : SNIFI-CI-ABJ-COC-00045821
-- ---------------------------------------------------------------------------
CREATE SEQUENCE parcelle_seq;

CREATE TABLE parcelles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snifi_id         text NOT NULL UNIQUE,
  ref_cadastrale   text,
  titre_foncier    text,
  commune_code     text NOT NULL REFERENCES territoires(code),
  quartier         text,
  superficie_m2    numeric(14, 2) CHECK (superficie_m2 > 0),     -- superficie juridique (titre)
  geom             geometry(MultiPolygon, 4326),
  superficie_geom_m2 numeric(14, 2) GENERATED ALWAYS AS (round(ST_Area(geom::geography)::numeric, 2)) STORED,
  statut           text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'subdivise', 'regroupe', 'litige', 'archive')),
  parent_id        uuid REFERENCES parcelles(id),                 -- subdivision / regroupement
  source_code      text REFERENCES sources_donnees(code),
  date_source      date,
  cree_le          timestamptz NOT NULL DEFAULT now(),
  modifie_le       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcelles_geom_idx ON parcelles USING gist (geom);
CREATE INDEX parcelles_commune_idx ON parcelles (commune_code);

-- Génère l'identifiant SNIFI à partir du code commune (CI-ABJ-COC → SNIFI-CI-ABJ-COC-00000001)
CREATE FUNCTION parcelle_snifi_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.snifi_id IS NULL THEN
    NEW.snifi_id := 'SNIFI-' || NEW.commune_code || '-' || lpad(nextval('snifi.parcelle_seq')::text, 8, '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER parcelles_snifi_id BEFORE INSERT ON parcelles
  FOR EACH ROW EXECUTE FUNCTION parcelle_snifi_id();

-- Droits / titres : lien propriétaire ↔ parcelle, historisé (date_debut / date_fin)
CREATE TABLE droits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proprietaire_id uuid NOT NULL REFERENCES proprietaires(id),
  parcelle_id     uuid NOT NULL REFERENCES parcelles(id),
  type_droit      text NOT NULL DEFAULT 'propriete' CHECK (type_droit IN (
                    'propriete', 'copropriete', 'usufruit', 'nue_propriete', 'bail_emphyteotique',
                    'concession', 'attestation_villageoise', 'autre')),
  quote_part      numeric(7, 4) NOT NULL DEFAULT 1 CHECK (quote_part > 0 AND quote_part <= 1),
  date_debut      date NOT NULL DEFAULT current_date,
  date_fin        date,
  transaction_id  uuid,                        -- événement à l'origine du droit
  document_ref    text,
  source_code     text REFERENCES sources_donnees(code),
  cree_le         timestamptz NOT NULL DEFAULT now(),
  CHECK (date_fin IS NULL OR date_fin >= date_debut)
);
CREATE INDEX droits_parcelle_idx ON droits (parcelle_id) WHERE date_fin IS NULL;
CREATE INDEX droits_proprietaire_idx ON droits (proprietaire_id) WHERE date_fin IS NULL;

-- ---------------------------------------------------------------------------
-- 04. Bâtiments et unités immobilières (Module 04)
-- PARCELLE → BÂTIMENT → NIVEAU → LOGEMENT / LOCAL
-- ---------------------------------------------------------------------------
CREATE TABLE batiments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snifi_id           text NOT NULL UNIQUE,
  parcelle_id        uuid NOT NULL REFERENCES parcelles(id),
  geom               geometry(MultiPolygon, 4326),
  usage              text NOT NULL DEFAULT 'habitation' CHECK (usage IN (
                       'habitation', 'commercial', 'mixte', 'bureau', 'industriel', 'public', 'autre')),
  surface_m2         numeric(12, 2) CHECK (surface_m2 > 0),        -- surface bâtie totale
  nb_niveaux         smallint NOT NULL DEFAULT 1 CHECK (nb_niveaux >= 1),
  nb_logements       smallint NOT NULL DEFAULT 0 CHECK (nb_logements >= 0),
  etat               text CHECK (etat IN ('neuf', 'bon', 'moyen', 'degrade', 'ruine', 'en_construction')),
  annee_construction smallint,
  valeur_estimative  numeric(16, 2),
  statut_fiscal      text NOT NULL DEFAULT 'a_evaluer' CHECK (statut_fiscal IN (
                       'a_evaluer', 'imposable', 'exonere', 'non_imposable')),
  source_code        text REFERENCES sources_donnees(code),
  date_source        date,
  cree_le            timestamptz NOT NULL DEFAULT now(),
  modifie_le         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX batiments_parcelle_idx ON batiments (parcelle_id);
CREATE INDEX batiments_geom_idx ON batiments USING gist (geom);

CREATE FUNCTION batiment_snifi_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF NEW.snifi_id IS NULL THEN
    SELECT count(*) + 1 INTO n FROM snifi.batiments WHERE parcelle_id = NEW.parcelle_id;
    SELECT p.snifi_id || '-B' || lpad(n::text, 3, '0') INTO NEW.snifi_id FROM snifi.parcelles p WHERE p.id = NEW.parcelle_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER batiments_snifi_id BEFORE INSERT ON batiments
  FOR EACH ROW EXECUTE FUNCTION batiment_snifi_id();

CREATE TABLE unites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batiment_id     uuid NOT NULL REFERENCES batiments(id),
  niveau          smallint NOT NULL DEFAULT 0,
  numero          text,
  type            text NOT NULL DEFAULT 'logement' CHECK (type IN ('logement', 'local_commercial', 'bureau', 'entrepot', 'autre')),
  usage           text NOT NULL DEFAULT 'habitation',
  surface_m2      numeric(10, 2) CHECK (surface_m2 > 0),
  valeur_locative numeric(14, 2) CHECK (valeur_locative >= 0),     -- valeur locative annuelle
  occupation      text CHECK (occupation IN ('proprietaire', 'locataire', 'vacant', 'inconnu')),
  cree_le         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX unites_batiment_idx ON unites (batiment_id);

-- Permis de construire (source Urbanisme) — utilisés par le moteur de rapprochement
CREATE TABLE permis (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero               text NOT NULL UNIQUE,
  parcelle_id          uuid NOT NULL REFERENCES parcelles(id),
  date_delivrance      date NOT NULL,
  surface_autorisee_m2 numeric(12, 2),
  nb_niveaux           smallint,
  usage                text,
  source_code          text REFERENCES sources_donnees(code) DEFAULT 'URBANISME',
  cree_le              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 05. Transactions / événements immobiliers (Module 06)
-- ---------------------------------------------------------------------------
CREATE TABLE transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN (
                     'vente', 'acquisition', 'donation', 'succession', 'mutation', 'subdivision',
                     'regroupement', 'changement_usage', 'transfert_droits')),
  parcelle_id      uuid NOT NULL REFERENCES parcelles(id),
  date_evenement   date NOT NULL,
  valeur           numeric(16, 2) CHECK (valeur >= 0),
  cedant_id        uuid REFERENCES proprietaires(id),
  acquereur_id     uuid REFERENCES proprietaires(id),
  acteur           text,                         -- notaire, service foncier…
  document_ref     text,
  source_code      text REFERENCES sources_donnees(code),
  statut           text NOT NULL DEFAULT 'enregistree' CHECK (statut IN ('enregistree', 'validee', 'appliquee', 'annulee')),
  appliquee_le     timestamptz,                  -- répercussion dans le référentiel des droits
  cree_le          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transactions_parcelle_idx ON transactions (parcelle_id);

ALTER TABLE droits
  ADD CONSTRAINT droits_transaction_fk FOREIGN KEY (transaction_id) REFERENCES transactions(id);

-- ---------------------------------------------------------------------------
-- 06. Fiscalité immobilière (Module 05) — règles paramétrables, aucun taux codé en dur
-- ---------------------------------------------------------------------------
CREATE TABLE zones_fiscales (
  code        text PRIMARY KEY,
  libelle     text NOT NULL,
  coefficient numeric(6, 3) NOT NULL DEFAULT 1,
  geom        geometry(MultiPolygon, 4326)
);
CREATE INDEX zones_fiscales_geom_idx ON zones_fiscales USING gist (geom);

CREATE TABLE regles_fiscales (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  libelle       text NOT NULL,
  impot         text NOT NULL,                      -- ex. impôt foncier bâti, non bâti…
  assiette      text NOT NULL CHECK (assiette IN ('valeur_locative', 'valeur_venale', 'surface_batie', 'surface_terrain')),
  usage         text,                               -- NULL = tous usages
  taux          numeric(9, 6) NOT NULL CHECK (taux >= 0),    -- taux ou tarif unitaire selon assiette
  abattement    numeric(5, 4) NOT NULL DEFAULT 0 CHECK (abattement >= 0 AND abattement < 1),
  applique_zone boolean NOT NULL DEFAULT false,     -- multiplie par le coefficient de zone
  date_debut    date NOT NULL,
  date_fin      date,
  reference_legale text,
  actif         boolean NOT NULL DEFAULT true,
  UNIQUE (code, date_debut)
);

CREATE TABLE exonerations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcelle_id uuid NOT NULL REFERENCES parcelles(id),
  impot       text,                                 -- NULL = tous impôts
  taux        numeric(5, 4) NOT NULL DEFAULT 1 CHECK (taux > 0 AND taux <= 1),  -- 1 = exonération totale
  motif       text NOT NULL,
  date_debut  date NOT NULL,
  date_fin    date,
  document_ref text,
  cree_le     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE declarations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proprietaire_id    uuid NOT NULL REFERENCES proprietaires(id),
  parcelle_id        uuid NOT NULL REFERENCES parcelles(id),
  exercice           smallint NOT NULL,
  surface_batie_declaree numeric(12, 2),
  valeur_locative_declaree numeric(16, 2),
  usage_declare      text,
  montant_declare    numeric(16, 2),
  date_depot         date NOT NULL DEFAULT current_date,
  source_code        text REFERENCES sources_donnees(code) DEFAULT 'DECLARATION',
  cree_le            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parcelle_id, proprietaire_id, exercice)
);

-- Impositions : montant théorique (calculé), déclaré, liquidé (émis par l'administration)
CREATE TABLE impositions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcelle_id       uuid NOT NULL REFERENCES parcelles(id),
  proprietaire_id   uuid NOT NULL REFERENCES proprietaires(id),
  exercice          smallint NOT NULL,
  regle_id          uuid NOT NULL REFERENCES regles_fiscales(id),
  base_imposable    numeric(16, 2) NOT NULL,
  montant_theorique numeric(16, 2) NOT NULL,
  montant_liquide   numeric(16, 2),
  date_echeance     date,
  statut            text NOT NULL DEFAULT 'calculee' CHECK (statut IN ('calculee', 'liquidee', 'soldee', 'annulee')),
  detail_calcul     jsonb NOT NULL DEFAULT '{}',    -- explicabilité du calcul
  calcule_le        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parcelle_id, proprietaire_id, exercice, regle_id)
);

CREATE TABLE paiements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imposition_id  uuid NOT NULL REFERENCES impositions(id),
  date_paiement  date NOT NULL,
  montant        numeric(16, 2) NOT NULL CHECK (montant > 0),
  reference      text NOT NULL UNIQUE,
  mode           text,
  source_code    text REFERENCES sources_donnees(code),
  cree_le        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 08. Anomalies (Modules 07/08) — bibliothèque de règles paramétrables
-- Une anomalie n'est PAS une qualification de fraude : c'est un signal à vérifier.
-- ---------------------------------------------------------------------------
CREATE TABLE regles_anomalies (
  code        text PRIMARY KEY,                  -- A001…
  libelle     text NOT NULL,
  description text NOT NULL,
  gravite     text NOT NULL CHECK (gravite IN ('faible', 'moyenne', 'elevee')),
  poids       smallint NOT NULL DEFAULT 10,      -- contribution à l'indice de priorité (V2)
  parametres  jsonb NOT NULL DEFAULT '{}',
  actif       boolean NOT NULL DEFAULT true
);

CREATE TABLE anomalies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  regle_code      text NOT NULL REFERENCES regles_anomalies(code),
  empreinte       text NOT NULL,                 -- évite les doublons d'une anomalie toujours ouverte
  parcelle_id     uuid REFERENCES parcelles(id),
  batiment_id     uuid REFERENCES batiments(id),
  proprietaire_id uuid REFERENCES proprietaires(id),
  gravite         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',   -- éléments objectifs ayant déclenché la règle
  statut          text NOT NULL DEFAULT 'ouverte' CHECK (statut IN (
                    'ouverte', 'en_examen', 'confirmee', 'rejetee', 'corrigee', 'cloturee')),
  commentaire     text,
  detectee_le     timestamptz NOT NULL DEFAULT now(),
  traitee_le      timestamptz,
  traitee_par     text
);
CREATE UNIQUE INDEX anomalies_ouvertes_uniq ON anomalies (empreinte) WHERE statut IN ('ouverte', 'en_examen');
CREATE INDEX anomalies_parcelle_idx ON anomalies (parcelle_id);
