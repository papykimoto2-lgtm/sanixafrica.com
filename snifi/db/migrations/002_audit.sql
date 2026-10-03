-- SNIFI — Migration 002 : traçabilité (§27, §28)
--
-- Chaque modification produit : QUI ? QUOI ? QUAND ? AVANT ? APRÈS ? POURQUOI ? SOURCE ?
-- Le journal est en ajout seul et chaîné par hachage SHA-256 : toute altération
-- a posteriori est détectable via snifi.verifier_journal().
-- Principe : un administrateur ne doit pas pouvoir modifier silencieusement une donnée
-- historique → toute mise à jour ou suppression exige un motif.

SET search_path = snifi, public;

CREATE TABLE journal_audit (
  id           bigserial PRIMARY KEY,
  horodatage   timestamptz NOT NULL DEFAULT clock_timestamp(),
  utilisateur  text NOT NULL,                  -- QUI
  action       text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),  -- QUOI
  table_nom    text NOT NULL,
  ligne_id     text,
  parcelle_ref text,                           -- parcelle concernée (historique d'un bien)
  champs       text[],                         -- champs modifiés (UPDATE)
  avant        jsonb,                          -- AVANT
  apres        jsonb,                          -- APRÈS
  motif        text,                           -- POURQUOI
  source       text,                           -- SOURCE
  hash_prec    text,
  hash         text NOT NULL
);
CREATE INDEX journal_audit_ligne_idx ON journal_audit (table_nom, ligne_id);
CREATE INDEX journal_audit_parcelle_idx ON journal_audit (parcelle_ref);

CREATE FUNCTION journal_hash(prec text, j journal_audit) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(
    coalesce(prec, '') || '|' ||
    concat_ws('|', extract(epoch FROM j.horodatage)::text, j.utilisateur, j.action, j.table_nom,
              j.ligne_id, j.parcelle_ref, array_to_string(j.champs, ','), j.avant::text, j.apres::text, j.motif, j.source),
    'sha256'), 'hex')
$$;

-- Journal immuable : ni UPDATE, ni DELETE, ni TRUNCATE
CREATE FUNCTION journal_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SNIFI : le journal d''audit est immuable (% interdit)', TG_OP USING ERRCODE = 'SN002';
END $$;
CREATE TRIGGER journal_audit_no_update BEFORE UPDATE OR DELETE ON journal_audit
  FOR EACH ROW EXECUTE FUNCTION journal_immuable();
CREATE TRIGGER journal_audit_no_truncate BEFORE TRUNCATE ON journal_audit
  FOR EACH STATEMENT EXECUTE FUNCTION journal_immuable();

-- Trigger générique d'audit. Le contexte applicatif est transmis par transaction via :
--   set_config('snifi.utilisateur', ..., true), set_config('snifi.motif', ..., true),
--   set_config('snifi.source', ..., true)
CREATE FUNCTION audit_ligne() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_user   text := coalesce(nullif(current_setting('snifi.utilisateur', true), ''), session_user::text);
  v_motif  text := nullif(current_setting('snifi.motif', true), '');
  v_source text := nullif(current_setting('snifi.source', true), '');
  v_avant  jsonb;
  v_apres  jsonb;
  v_champs text[];
  v_prec   text;
  j        snifi.journal_audit;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND v_motif IS NULL THEN
    RAISE EXCEPTION 'SNIFI : motif obligatoire pour % sur %', TG_OP, TG_TABLE_NAME USING ERRCODE = 'SN001';
  END IF;

  IF TG_OP <> 'INSERT' THEN v_avant := to_jsonb(OLD) - 'mot_de_passe' - 'modifie_le'; END IF;
  IF TG_OP <> 'DELETE' THEN v_apres := to_jsonb(NEW) - 'mot_de_passe' - 'modifie_le'; END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO v_champs
      FROM jsonb_object_keys(v_apres) k
     WHERE v_apres -> k IS DISTINCT FROM v_avant -> k;
    IF v_champs IS NULL THEN RETURN NULL; END IF;   -- aucune modification réelle
    -- seuls les champs modifiés sont conservés dans AVANT / APRÈS
    SELECT jsonb_object_agg(k, v_avant -> k), jsonb_object_agg(k, v_apres -> k)
      INTO v_avant, v_apres FROM unnest(v_champs) k;
  END IF;

  -- sérialise l'écriture pour garantir une chaîne de hachage linéaire
  PERFORM pg_advisory_xact_lock(hashtext('snifi.journal_audit'));
  SELECT hash INTO v_prec FROM snifi.journal_audit ORDER BY id DESC LIMIT 1;

  j.horodatage  := clock_timestamp();
  j.utilisateur := v_user;
  j.action      := TG_OP;
  j.table_nom   := TG_TABLE_NAME;
  j.ligne_id    := coalesce(v_apres ->> 'id', v_avant ->> 'id', (to_jsonb(coalesce(NEW, OLD)) ->> 'id'));
  j.parcelle_ref := CASE WHEN TG_TABLE_NAME = 'parcelles' THEN j.ligne_id
                          ELSE to_jsonb(coalesce(NEW, OLD)) ->> 'parcelle_id' END;
  j.champs      := v_champs;
  j.avant       := v_avant;
  j.apres       := v_apres;
  j.motif       := v_motif;
  j.source      := v_source;

  INSERT INTO snifi.journal_audit (horodatage, utilisateur, action, table_nom, ligne_id, parcelle_ref, champs, avant, apres, motif, source, hash_prec, hash)
  VALUES (j.horodatage, j.utilisateur, j.action, j.table_nom, j.ligne_id, j.parcelle_ref, j.champs, j.avant, j.apres, j.motif, j.source,
          v_prec, snifi.journal_hash(v_prec, j));
  RETURN NULL;
END $$;

-- Vérifie l'intégrité de la chaîne ; retourne la première entrée corrompue (ou rien)
CREATE FUNCTION verifier_journal() RETURNS TABLE (id bigint, attendu text, trouve text) LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT j AS ligne, j.id, j.hash, j.hash_prec, lag(j.hash) OVER (ORDER BY j.id) AS prec_reel
      FROM snifi.journal_audit j
  )
  SELECT c.id, snifi.journal_hash(c.prec_reel, c.ligne), c.hash
    FROM c
   WHERE c.hash_prec IS DISTINCT FROM c.prec_reel
      OR c.hash <> snifi.journal_hash(c.prec_reel, c.ligne)
   ORDER BY c.id
   LIMIT 1
$$;

CREATE FUNCTION maj_modifie_le() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.modifie_le := now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'utilisateurs', 'proprietaires', 'parcelles', 'droits', 'batiments', 'unites', 'permis',
    'transactions', 'regles_fiscales', 'exonerations', 'declarations', 'impositions', 'paiements',
    'regles_anomalies', 'anomalies', 'zones_fiscales']
  LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON snifi.%I FOR EACH ROW EXECUTE FUNCTION snifi.audit_ligne()',
                   t || '_audit', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['proprietaires', 'parcelles', 'batiments']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON snifi.%I FOR EACH ROW EXECUTE FUNCTION snifi.maj_modifie_le()',
                   t || '_modifie_le', t);
  END LOOP;
END $$;
