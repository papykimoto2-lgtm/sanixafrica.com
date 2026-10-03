-- SNIFI — Migration 005 : API nationale (Module 16)
--
-- L'API est exposée par Supabase sous forme de fonctions RPC (POST /rest/v1/rpc/<nom>),
-- appelées avec la session Supabase Auth de l'utilisateur. Chaque fonction :
--   1. identifie l'utilisateur (auth.uid()) et vérifie son rôle (RBAC, moindre privilège) ;
--   2. restreint les données à son périmètre territorial ;
--   3. transmet QUI / POURQUOI / SOURCE au journal d'audit.
-- Les tables du schéma snifi ne sont jamais exposées directement.

SET search_path = snifi, public, extensions;

-- ---------------------------------------------------------------------------
-- Sécurité
-- ---------------------------------------------------------------------------
CREATE FUNCTION snifi.roles(p_groupe text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_groupe
    WHEN 'lecture'        THEN ARRAY['admin_national', 'admin_regional', 'agent_fiscal', 'controleur', 'collectivite',
                                     'service_foncier', 'urbanisme', 'auditeur']
    WHEN 'proprietaires'  THEN ARRAY['admin_national', 'admin_regional', 'agent_fiscal', 'service_foncier']
    WHEN 'parcelles'      THEN ARRAY['admin_national', 'service_foncier']
    WHEN 'batiments'      THEN ARRAY['admin_national', 'service_foncier', 'urbanisme', 'agent_fiscal']
    WHEN 'permis'         THEN ARRAY['admin_national', 'urbanisme']
    WHEN 'transactions'   THEN ARRAY['admin_national', 'service_foncier', 'notaire']
    WHEN 'appliquer'      THEN ARRAY['admin_national', 'service_foncier']
    WHEN 'regles_fisc'    THEN ARRAY['admin_national']
    WHEN 'fiscalite'      THEN ARRAY['admin_national', 'agent_fiscal']
    WHEN 'anomalies'      THEN ARRAY['admin_national', 'controleur', 'agent_fiscal']
    WHEN 'regles_ano'     THEN ARRAY['admin_national']
    WHEN 'audit'          THEN ARRAY['admin_national', 'auditeur']
    WHEN 'tous'           THEN ARRAY['admin_national', 'admin_regional', 'agent_fiscal', 'controleur', 'collectivite',
                                     'service_foncier', 'urbanisme', 'notaire', 'promoteur', 'proprietaire', 'auditeur', 'admin_technique']
  END
$$;

/** Identifie l'utilisateur, contrôle son rôle et positionne le contexte d'audit de la transaction. */
CREATE FUNCTION snifi.ctx(p_groupe text, p_motif text DEFAULT NULL, p_source text DEFAULT 'API') RETURNS snifi.profils
LANGUAGE plpgsql AS $$
DECLARE u snifi.profils;
BEGIN
  SELECT * INTO u FROM snifi.profils WHERE user_id = auth.uid() AND actif;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authentification requise : aucun profil SNIFI actif pour ce compte' USING ERRCODE = 'SN401';
  END IF;
  IF NOT (u.role = ANY (snifi.roles(p_groupe))) THEN
    RAISE EXCEPTION 'Droits insuffisants pour cette opération' USING ERRCODE = 'SN403';
  END IF;
  PERFORM set_config('snifi.utilisateur', u.login || ' (' || u.role || ')', true),
          set_config('snifi.motif', coalesce(p_motif, ''), true),
          set_config('snifi.source', coalesce(p_source, 'API'), true);
  RETURN u;
END $$;

CREATE FUNCTION snifi.exiger_motif(p_motif text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_motif IS NULL OR length(trim(p_motif)) < 5 THEN
    RAISE EXCEPTION 'Un motif (5 caractères minimum) est obligatoire pour toute modification' USING ERRCODE = 'SN001';
  END IF;
END $$;

CREATE FUNCTION snifi.erreur(p_message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = 'SN400';
END $$;

/** Vrai si la commune est dans le périmètre de l'utilisateur (accès national si pas de territoire). */
CREATE FUNCTION snifi.dans_perimetre(u snifi.profils, p_commune text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT u.territoire_code IS NULL OR p_commune = u.territoire_code OR p_commune LIKE u.territoire_code || '-%'
$$;

CREATE FUNCTION snifi.taille(p int) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT least(greatest(coalesce(p, 50), 1), 500) $$;
CREATE FUNCTION snifi.decalage(p_page int, p_taille int) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT (greatest(coalesce(p_page, 1), 1) - 1) * snifi.taille(p_taille)
$$;

-- ---------------------------------------------------------------------------
-- Session
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.moi() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('tous');
BEGIN
  RETURN to_jsonb(u);
END $$;

-- ---------------------------------------------------------------------------
-- Module 01 — Propriétaires
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.proprietaires_lister(p_q text DEFAULT NULL, p_type text DEFAULT NULL, p_page int DEFAULT 1, p_taille int DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); res jsonb;
BEGIN
  SELECT jsonb_build_object('total', coalesce(max(x.total), 0), 'page', p_page,
                            'elements', coalesce(jsonb_agg(to_jsonb(x) - 'total' ORDER BY x.nom), '[]'))
    INTO res
    FROM (SELECT p.*, (SELECT count(*) FROM droits d WHERE d.proprietaire_id = p.id AND d.date_fin IS NULL)::int AS nb_biens,
                 count(*) OVER ()::int AS total
            FROM proprietaires p
           WHERE p.statut <> 'fusionne'
             AND (p_q IS NULL OR p.nom ILIKE '%' || p_q || '%' OR p.snifi_id ILIKE '%' || p_q || '%' OR p.identifiant_fiscal ILIKE '%' || p_q || '%')
             AND (p_type IS NULL OR p.type = p_type)
           ORDER BY p.nom LIMIT snifi.taille(p_taille) OFFSET snifi.decalage(p_page, p_taille)) x;
  RETURN res;
END $$;

CREATE FUNCTION public.proprietaire_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('tous'); res jsonb;
BEGIN
  IF NOT (u.role = ANY (snifi.roles('lecture'))) AND u.proprietaire_id IS DISTINCT FROM p_id THEN
    RAISE EXCEPTION 'Droits insuffisants pour cette opération' USING ERRCODE = 'SN403';
  END IF;
  SELECT to_jsonb(p) || jsonb_build_object('biens', coalesce((
           SELECT jsonb_agg(jsonb_build_object('droit_id', d.id, 'type_droit', d.type_droit, 'quote_part', d.quote_part,
                    'date_debut', d.date_debut, 'date_fin', d.date_fin, 'parcelle_id', pa.id, 'snifi_id', pa.snifi_id,
                    'commune_code', pa.commune_code, 'quartier', pa.quartier, 'superficie_m2', pa.superficie_m2)
                  ORDER BY d.date_fin NULLS FIRST, d.date_debut DESC)
             FROM droits d JOIN parcelles pa ON pa.id = d.parcelle_id WHERE d.proprietaire_id = p.id), '[]'))
    INTO res FROM proprietaires p WHERE p.id = p_id;
  IF res IS NULL THEN PERFORM snifi.erreur('Propriétaire introuvable'); END IF;
  RETURN res;
END $$;

CREATE FUNCTION public.proprietaire_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('proprietaires'); r proprietaires;
BEGIN
  IF length(trim(coalesce(p_data ->> 'nom', ''))) < 2 THEN PERFORM snifi.erreur('Le nom ou la raison sociale est obligatoire'); END IF;
  INSERT INTO proprietaires (identifiant_fiscal, type, nom, telephone, email, adresse, source_code, date_source)
  VALUES (nullif(trim(p_data ->> 'identifiant_fiscal'), ''), p_data ->> 'type', trim(p_data ->> 'nom'),
          nullif(p_data ->> 'telephone', ''), nullif(p_data ->> 'email', ''), nullif(p_data ->> 'adresse', ''),
          coalesce(p_data ->> 'source_code', 'SNIFI'), (p_data ->> 'date_source')::date)
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.proprietaire_modifier(p_id uuid, p_data jsonb, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('proprietaires', p_motif); o proprietaires; n proprietaires;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  SELECT * INTO o FROM proprietaires WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM snifi.erreur('Propriétaire introuvable'); END IF;
  n := jsonb_populate_record(o, p_data);
  IF n.statut = 'fusionne' AND o.statut <> 'fusionne' THEN PERFORM snifi.erreur('Utilisez la fusion de doublons'); END IF;
  UPDATE proprietaires SET identifiant_fiscal = n.identifiant_fiscal, type = n.type, nom = n.nom, telephone = n.telephone,
         email = n.email, adresse = n.adresse, source_code = n.source_code, date_source = n.date_source, statut = n.statut
   WHERE id = p_id RETURNING * INTO n;
  RETURN to_jsonb(n);
END $$;

/** Fusion de doublons : droits, déclarations et transactions du doublon rattachés au propriétaire conservé. */
CREATE FUNCTION public.proprietaire_fusionner(p_id uuid, p_doublon uuid, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('proprietaires', p_motif); n int;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  IF p_id = p_doublon THEN PERFORM snifi.erreur('Un propriétaire ne peut pas être fusionné avec lui-même'); END IF;
  IF (SELECT count(*) FROM proprietaires WHERE id IN (p_id, p_doublon) AND statut <> 'fusionne') <> 2 THEN
    PERFORM snifi.erreur('Propriétaire(s) introuvable(s) ou déjà fusionné(s)');
  END IF;
  UPDATE droits SET proprietaire_id = p_id WHERE proprietaire_id = p_doublon;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE declarations SET proprietaire_id = p_id WHERE proprietaire_id = p_doublon;
  UPDATE transactions SET cedant_id = p_id WHERE cedant_id = p_doublon;
  UPDATE transactions SET acquereur_id = p_id WHERE acquereur_id = p_doublon;
  UPDATE proprietaires SET statut = 'fusionne', fusionne_vers = p_id WHERE id = p_doublon;
  RETURN jsonb_build_object('conserve', p_id, 'fusionne', p_doublon, 'droits_rattaches', n);
END $$;

-- ---------------------------------------------------------------------------
-- Module 02 — Parcelles
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.parcelles_lister(p_q text DEFAULT NULL, p_commune text DEFAULT NULL, p_proprietaire text DEFAULT NULL,
                                        p_page int DEFAULT 1, p_taille int DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); res jsonb;
BEGIN
  SELECT jsonb_build_object('total', coalesce(max(x.total), 0), 'page', p_page,
                            'elements', coalesce(jsonb_agg(to_jsonb(x) - 'total' ORDER BY x.snifi_id), '[]'))
    INTO res
    FROM (SELECT p.id, p.snifi_id, p.ref_cadastrale, p.titre_foncier, p.commune_code, t.nom AS commune, p.quartier,
                 p.superficie_m2, p.superficie_geom_m2, p.statut,
                 (SELECT string_agg(o.nom, ', ') FROM droits d JOIN proprietaires o ON o.id = d.proprietaire_id
                   WHERE d.parcelle_id = p.id AND d.date_fin IS NULL) AS proprietaires,
                 (SELECT count(*) FROM batiments b WHERE b.parcelle_id = p.id)::int AS nb_batiments,
                 (SELECT count(*) FROM anomalies a WHERE a.parcelle_id = p.id AND a.statut IN ('ouverte', 'en_examen'))::int AS nb_anomalies,
                 count(*) OVER ()::int AS total
            FROM parcelles p JOIN territoires t ON t.code = p.commune_code
           WHERE snifi.dans_perimetre(u, p.commune_code)
             AND (p_commune IS NULL OR p.commune_code = p_commune)
             AND (p_q IS NULL OR p.snifi_id ILIKE '%' || p_q || '%' OR p.ref_cadastrale ILIKE '%' || p_q || '%'
                  OR p.titre_foncier ILIKE '%' || p_q || '%' OR p.quartier ILIKE '%' || p_q || '%')
             AND (p_proprietaire IS NULL OR EXISTS (
                   SELECT 1 FROM droits d JOIN proprietaires o ON o.id = d.proprietaire_id
                    WHERE d.parcelle_id = p.id AND d.date_fin IS NULL
                      AND (o.nom ILIKE '%' || p_proprietaire || '%' OR o.snifi_id ILIKE '%' || p_proprietaire || '%')))
           ORDER BY p.snifi_id LIMIT snifi.taille(p_taille) OFFSET snifi.decalage(p_page, p_taille)) x;
  RETURN res;
END $$;

CREATE FUNCTION public.parcelle_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); res jsonb;
BEGIN
  SELECT jsonb_build_object(
      'id', p.id, 'snifi_id', p.snifi_id, 'ref_cadastrale', p.ref_cadastrale, 'titre_foncier', p.titre_foncier,
      'commune_code', p.commune_code, 'commune', t.nom, 'quartier', p.quartier, 'superficie_m2', p.superficie_m2,
      'superficie_geom_m2', p.superficie_geom_m2, 'statut', p.statut, 'source_code', p.source_code, 'date_source', p.date_source,
      'cree_le', p.cree_le, 'modifie_le', p.modifie_le, 'geometrie', ST_AsGeoJSON(p.geom)::jsonb,
      'qualite', jsonb_build_object('source', s.libelle, 'officielle', s.officielle, 'fiabilite', s.fiabilite,
                                    'date', p.date_source, 'actualite_jours', current_date - p.date_source),
      'droits', coalesce((SELECT jsonb_agg(to_jsonb(d) || jsonb_build_object('nom', o.nom, 'proprietaire_snifi_id', o.snifi_id,
                                   'proprietaire_type', o.type) ORDER BY d.date_fin NULLS FIRST, d.date_debut DESC)
                            FROM droits d JOIN proprietaires o ON o.id = d.proprietaire_id WHERE d.parcelle_id = p.id), '[]'),
      'batiments', coalesce((SELECT jsonb_agg(to_jsonb(b) - 'geom' || jsonb_build_object(
                                   'geom', ST_AsGeoJSON(b.geom)::jsonb,
                                   'nb_unites', (SELECT count(*) FROM unites un WHERE un.batiment_id = b.id),
                                   'valeur_locative_totale', (SELECT sum(un.valeur_locative) FROM unites un WHERE un.batiment_id = b.id))
                                 ORDER BY b.snifi_id) FROM batiments b WHERE b.parcelle_id = p.id), '[]'),
      'permis', coalesce((SELECT jsonb_agg(to_jsonb(pe) ORDER BY pe.date_delivrance DESC) FROM permis pe WHERE pe.parcelle_id = p.id), '[]'),
      'transactions', coalesce((SELECT jsonb_agg(to_jsonb(tr) || jsonb_build_object('cedant', c.nom, 'acquereur', a.nom) ORDER BY tr.date_evenement DESC)
                                  FROM transactions tr LEFT JOIN proprietaires c ON c.id = tr.cedant_id
                                  LEFT JOIN proprietaires a ON a.id = tr.acquereur_id WHERE tr.parcelle_id = p.id), '[]'),
      'anomalies', coalesce((SELECT jsonb_agg(to_jsonb(an) || jsonb_build_object('libelle', r.libelle) ORDER BY an.detectee_le DESC)
                               FROM anomalies an JOIN regles_anomalies r ON r.code = an.regle_code WHERE an.parcelle_id = p.id), '[]'))
    INTO res
    FROM parcelles p JOIN territoires t ON t.code = p.commune_code LEFT JOIN sources_donnees s ON s.code = p.source_code
   WHERE p.id = p_id AND snifi.dans_perimetre(u, p.commune_code);
  IF res IS NULL THEN PERFORM snifi.erreur('Parcelle introuvable'); END IF;
  RETURN res;
END $$;

/** Historique complet : qui, quoi, quand, avant, après, pourquoi, source. */
CREATE FUNCTION public.parcelle_historique(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM parcelles WHERE id = p_id AND snifi.dans_perimetre(u, commune_code)) THEN
    PERFORM snifi.erreur('Parcelle introuvable');
  END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', j.id, 'horodatage', j.horodatage, 'utilisateur', j.utilisateur,
                     'action', j.action, 'table_nom', j.table_nom, 'ligne_id', j.ligne_id, 'champs', j.champs,
                     'avant', j.avant, 'apres', j.apres, 'motif', j.motif, 'source', j.source) ORDER BY j.id DESC)
                     FROM (SELECT * FROM journal_audit WHERE parcelle_ref = p_id::text ORDER BY id DESC LIMIT 500) j), '[]');
END $$;

CREATE FUNCTION public.parcelle_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('parcelles'); r parcelles;
BEGIN
  INSERT INTO parcelles (commune_code, ref_cadastrale, titre_foncier, quartier, superficie_m2, geom, source_code, date_source)
  VALUES (p_data ->> 'commune_code', p_data ->> 'ref_cadastrale', p_data ->> 'titre_foncier', p_data ->> 'quartier',
          (p_data ->> 'superficie_m2')::numeric,
          CASE WHEN p_data ? 'geometrie' THEN ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(p_data -> 'geometrie'), 4326)) END,
          coalesce(p_data ->> 'source_code', 'SNIFI'), (p_data ->> 'date_source')::date)
  RETURNING * INTO r;
  IF r.geom IS NOT NULL AND NOT ST_IsValid(r.geom) THEN
    PERFORM snifi.erreur('Géométrie invalide (auto-intersection, anneau ouvert…)');
  END IF;
  IF p_data ? 'proprietaire_id' THEN
    INSERT INTO droits (proprietaire_id, parcelle_id, source_code)
    VALUES ((p_data ->> 'proprietaire_id')::uuid, r.id, coalesce(p_data ->> 'source_code', 'SNIFI'));
  END IF;
  RETURN jsonb_build_object('id', r.id, 'snifi_id', r.snifi_id, 'superficie_geom_m2', r.superficie_geom_m2);
END $$;

CREATE FUNCTION public.parcelle_modifier(p_id uuid, p_data jsonb, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('parcelles', p_motif); o parcelles; n parcelles;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  SELECT * INTO o FROM parcelles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM snifi.erreur('Parcelle introuvable'); END IF;
  n := jsonb_populate_record(o, p_data - 'geometrie' - 'geom' - 'superficie_geom_m2' - 'snifi_id' - 'id');
  UPDATE parcelles SET ref_cadastrale = n.ref_cadastrale, titre_foncier = n.titre_foncier, quartier = n.quartier,
         superficie_m2 = n.superficie_m2, source_code = n.source_code, date_source = n.date_source, statut = n.statut,
         geom = CASE WHEN p_data ? 'geometrie' THEN ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(p_data -> 'geometrie'), 4326)) ELSE geom END
   WHERE id = p_id RETURNING * INTO n;
  RETURN jsonb_build_object('id', n.id, 'snifi_id', n.snifi_id, 'superficie_m2', n.superficie_m2,
                            'superficie_geom_m2', n.superficie_geom_m2, 'statut', n.statut);
END $$;

CREATE FUNCTION public.droit_ajouter(p_parcelle uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('parcelles'); r droits; v_type text := coalesce(p_data ->> 'type_droit', 'propriete');
        v_qp numeric := coalesce((p_data ->> 'quote_part')::numeric, 1);
BEGIN
  IF (SELECT coalesce(sum(quote_part), 0) FROM droits WHERE parcelle_id = p_parcelle AND date_fin IS NULL AND type_droit = v_type) + v_qp > 1.0001 THEN
    PERFORM snifi.erreur('La somme des quotes-parts actives dépasserait 100 %');
  END IF;
  INSERT INTO droits (proprietaire_id, parcelle_id, type_droit, quote_part, date_debut, document_ref, source_code)
  VALUES ((p_data ->> 'proprietaire_id')::uuid, p_parcelle, v_type, v_qp, coalesce((p_data ->> 'date_debut')::date, current_date),
          p_data ->> 'document_ref', coalesce(p_data ->> 'source_code', 'SNIFI'))
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

-- ---------------------------------------------------------------------------
-- Module 04 — Bâtiments, unités, permis
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.batiment_detail(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); res jsonb;
BEGIN
  SELECT to_jsonb(b) - 'geom' || jsonb_build_object('geom', ST_AsGeoJSON(b.geom)::jsonb, 'parcelle_snifi_id', p.snifi_id,
           'unites', coalesce((SELECT jsonb_agg(to_jsonb(un) ORDER BY un.niveau, un.numero) FROM unites un WHERE un.batiment_id = b.id), '[]'))
    INTO res FROM batiments b JOIN parcelles p ON p.id = b.parcelle_id
   WHERE b.id = p_id AND snifi.dans_perimetre(u, p.commune_code);
  IF res IS NULL THEN PERFORM snifi.erreur('Bâtiment introuvable'); END IF;
  RETURN res;
END $$;

CREATE FUNCTION public.batiment_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('batiments'); r batiments;
BEGIN
  INSERT INTO batiments (parcelle_id, geom, usage, surface_m2, nb_niveaux, nb_logements, etat, annee_construction,
                         valeur_estimative, statut_fiscal, source_code, date_source)
  VALUES ((p_data ->> 'parcelle_id')::uuid,
          CASE WHEN p_data ? 'geometrie' THEN ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(p_data -> 'geometrie'), 4326)) END,
          coalesce(p_data ->> 'usage', 'habitation'), (p_data ->> 'surface_m2')::numeric, coalesce((p_data ->> 'nb_niveaux')::int, 1),
          coalesce((p_data ->> 'nb_logements')::int, 0), p_data ->> 'etat', (p_data ->> 'annee_construction')::int,
          (p_data ->> 'valeur_estimative')::numeric, coalesce(p_data ->> 'statut_fiscal', 'a_evaluer'),
          coalesce(p_data ->> 'source_code', 'SNIFI'), (p_data ->> 'date_source')::date)
  RETURNING * INTO r;
  RETURN jsonb_build_object('id', r.id, 'snifi_id', r.snifi_id, 'parcelle_id', r.parcelle_id);
END $$;

CREATE FUNCTION public.batiment_modifier(p_id uuid, p_data jsonb, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('batiments', p_motif); o batiments; n batiments;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  SELECT * INTO o FROM batiments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM snifi.erreur('Bâtiment introuvable'); END IF;
  n := jsonb_populate_record(o, p_data - 'geom' - 'id' - 'snifi_id' - 'parcelle_id');
  UPDATE batiments SET usage = n.usage, surface_m2 = n.surface_m2, nb_niveaux = n.nb_niveaux, nb_logements = n.nb_logements,
         etat = n.etat, annee_construction = n.annee_construction, valeur_estimative = n.valeur_estimative,
         statut_fiscal = n.statut_fiscal, source_code = n.source_code, date_source = n.date_source
   WHERE id = p_id RETURNING * INTO n;
  RETURN to_jsonb(n) - 'geom';
END $$;

CREATE FUNCTION public.unite_ajouter(p_batiment uuid, p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('batiments'); r unites;
BEGIN
  INSERT INTO unites (batiment_id, niveau, numero, type, usage, surface_m2, valeur_locative, occupation)
  VALUES (p_batiment, coalesce((p_data ->> 'niveau')::int, 0), p_data ->> 'numero', coalesce(p_data ->> 'type', 'logement'),
          coalesce(p_data ->> 'usage', 'habitation'), (p_data ->> 'surface_m2')::numeric, (p_data ->> 'valeur_locative')::numeric,
          p_data ->> 'occupation')
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.permis_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('permis', NULL, 'URBANISME'); r permis;
BEGIN
  INSERT INTO permis (numero, parcelle_id, date_delivrance, surface_autorisee_m2, nb_niveaux, usage)
  VALUES (p_data ->> 'numero', (p_data ->> 'parcelle_id')::uuid, (p_data ->> 'date_delivrance')::date,
          (p_data ->> 'surface_autorisee_m2')::numeric, (p_data ->> 'nb_niveaux')::int, p_data ->> 'usage')
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

-- ---------------------------------------------------------------------------
-- Module 03 — Cartographie (GeoJSON)
-- p_bbox = {ouest, sud, est, nord} en WGS84
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.carto_parcelles(p_bbox float8[] DEFAULT NULL, p_commune text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN jsonb_build_object('type', 'FeatureCollection', 'features', coalesce((
    SELECT jsonb_agg(jsonb_build_object('type', 'Feature', 'geometry', ST_AsGeoJSON(p.geom)::jsonb, 'properties', jsonb_build_object(
             'id', p.id, 'snifi_id', p.snifi_id, 'quartier', p.quartier, 'commune', p.commune_code,
             'superficie_m2', p.superficie_m2, 'statut', p.statut,
             'nb_batiments', (SELECT count(*) FROM batiments b WHERE b.parcelle_id = p.id),
             'nb_anomalies', (SELECT count(*) FROM anomalies a WHERE a.parcelle_id = p.id AND a.statut IN ('ouverte', 'en_examen')),
             'proprietaires', (SELECT string_agg(o.nom, ', ') FROM droits d JOIN proprietaires o ON o.id = d.proprietaire_id
                                WHERE d.parcelle_id = p.id AND d.date_fin IS NULL))))
      FROM (SELECT * FROM parcelles p
             WHERE p.geom IS NOT NULL AND snifi.dans_perimetre(u, p.commune_code)
               AND (p_commune IS NULL OR p.commune_code = p_commune)
               AND (p_bbox IS NULL OR p.geom && ST_MakeEnvelope(p_bbox[1], p_bbox[2], p_bbox[3], p_bbox[4], 4326))
             LIMIT 5000) p), '[]'));
END $$;

CREATE FUNCTION public.carto_batiments(p_bbox float8[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN jsonb_build_object('type', 'FeatureCollection', 'features', coalesce((
    SELECT jsonb_agg(jsonb_build_object('type', 'Feature', 'geometry', ST_AsGeoJSON(b.geom)::jsonb, 'properties', jsonb_build_object(
             'id', b.id, 'snifi_id', b.snifi_id, 'usage', b.usage, 'nb_niveaux', b.nb_niveaux,
             'statut_fiscal', b.statut_fiscal, 'parcelle_id', b.parcelle_id)))
      FROM (SELECT b.* FROM batiments b JOIN parcelles p ON p.id = b.parcelle_id
             WHERE b.geom IS NOT NULL AND snifi.dans_perimetre(u, p.commune_code)
               AND (p_bbox IS NULL OR b.geom && ST_MakeEnvelope(p_bbox[1], p_bbox[2], p_bbox[3], p_bbox[4], 4326))
             LIMIT 10000) b), '[]'));
END $$;

CREATE FUNCTION public.carto_zones_fiscales() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN jsonb_build_object('type', 'FeatureCollection', 'features', coalesce((
    SELECT jsonb_agg(jsonb_build_object('type', 'Feature', 'geometry', ST_AsGeoJSON(geom)::jsonb,
             'properties', jsonb_build_object('code', code, 'libelle', libelle, 'coefficient', coefficient)))
      FROM zones_fiscales WHERE geom IS NOT NULL), '[]'));
END $$;

CREATE FUNCTION public.carto_territoires() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN jsonb_build_object('type', 'FeatureCollection', 'features', coalesce((
    SELECT jsonb_agg(jsonb_build_object('type', 'Feature', 'geometry', ST_AsGeoJSON(geom)::jsonb,
             'properties', jsonb_build_object('code', code, 'nom', nom, 'type', type)))
      FROM territoires WHERE geom IS NOT NULL), '[]'));
END $$;

-- ---------------------------------------------------------------------------
-- Module 05 — Fiscalité
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.fiscalite_regles() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.impot, r.code, r.date_debut DESC) FROM regles_fiscales r), '[]');
END $$;

CREATE FUNCTION public.regle_fiscale_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('regles_fisc'); r regles_fiscales;
BEGIN
  INSERT INTO regles_fiscales (code, libelle, impot, assiette, usage, taux, abattement, applique_zone, date_debut, date_fin, reference_legale)
  VALUES (p_data ->> 'code', p_data ->> 'libelle', p_data ->> 'impot', p_data ->> 'assiette', p_data ->> 'usage',
          (p_data ->> 'taux')::numeric, coalesce((p_data ->> 'abattement')::numeric, 0), coalesce((p_data ->> 'applique_zone')::boolean, false),
          (p_data ->> 'date_debut')::date, (p_data ->> 'date_fin')::date, p_data ->> 'reference_legale')
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

/** Calcule les montants théoriques. Les impositions déjà liquidées ne sont pas modifiées. */
CREATE FUNCTION public.fiscalite_calculer(p_exercice int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('fiscalite', 'Calcul des impositions théoriques ' || p_exercice, 'MOTEUR-FISCAL');
BEGIN
  RETURN jsonb_build_object('exercice', p_exercice, 'impositions_calculees', snifi.calculer_impositions(p_exercice));
END $$;

/** Liquidation : le montant théorique devient le montant émis par l'administration. */
CREATE FUNCTION public.fiscalite_liquider(p_exercice int, p_echeance date, p_motif text, p_parcelle uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('fiscalite', p_motif); n int; total numeric;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  WITH maj AS (
    UPDATE impositions i SET montant_liquide = montant_theorique, date_echeance = p_echeance, statut = 'liquidee'
      FROM parcelles p
     WHERE p.id = i.parcelle_id AND i.exercice = p_exercice AND i.statut = 'calculee'
       AND (p_parcelle IS NULL OR i.parcelle_id = p_parcelle) AND snifi.dans_perimetre(u, p.commune_code)
    RETURNING i.montant_liquide)
  SELECT count(*), coalesce(sum(montant_liquide), 0) INTO n, total FROM maj;
  RETURN jsonb_build_object('exercice', p_exercice, 'impositions_liquidees', n, 'montant_total', total);
END $$;

CREATE FUNCTION public.paiement_enregistrer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('fiscalite', 'Paiement ' || coalesce(p_data ->> 'reference', ''));
        v_imp uuid := (p_data ->> 'imposition_id')::uuid; v_statut text; r paiements;
BEGIN
  SELECT statut INTO v_statut FROM impositions WHERE id = v_imp FOR UPDATE;
  IF NOT FOUND THEN PERFORM snifi.erreur('Imposition introuvable'); END IF;
  IF v_statut NOT IN ('liquidee', 'soldee') THEN
    PERFORM snifi.erreur('Un paiement ne peut être enregistré que sur une imposition liquidée');
  END IF;
  INSERT INTO paiements (imposition_id, montant, date_paiement, reference, mode, source_code)
  VALUES (v_imp, (p_data ->> 'montant')::numeric, (p_data ->> 'date_paiement')::date, p_data ->> 'reference',
          p_data ->> 'mode', p_data ->> 'source_code')
  RETURNING * INTO r;
  UPDATE impositions i SET statut = 'soldee'
   WHERE i.id = v_imp AND i.statut = 'liquidee'
     AND (SELECT sum(montant) FROM paiements WHERE imposition_id = i.id) >= i.montant_liquide;
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.exoneration_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('fiscalite'); r exonerations;
BEGIN
  INSERT INTO exonerations (parcelle_id, impot, taux, motif, date_debut, date_fin, document_ref)
  VALUES ((p_data ->> 'parcelle_id')::uuid, p_data ->> 'impot', coalesce((p_data ->> 'taux')::numeric, 1),
          p_data ->> 'motif_exoneration', (p_data ->> 'date_debut')::date, (p_data ->> 'date_fin')::date, p_data ->> 'document_ref')
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.dossier_fiscal(p_parcelle uuid, p_exercice int DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('tous');
BEGIN
  IF u.role = 'proprietaire' THEN
    IF NOT EXISTS (SELECT 1 FROM droits WHERE parcelle_id = p_parcelle AND proprietaire_id = u.proprietaire_id) THEN
      PERFORM snifi.erreur('Parcelle introuvable');
    END IF;
  ELSIF NOT (u.role = ANY (snifi.roles('lecture')))
     OR NOT EXISTS (SELECT 1 FROM parcelles WHERE id = p_parcelle AND snifi.dans_perimetre(u, commune_code)) THEN
    RAISE EXCEPTION 'Droits insuffisants pour cette opération' USING ERRCODE = 'SN403';
  END IF;
  RETURN jsonb_build_object(
    'synthese', coalesce((SELECT jsonb_agg(to_jsonb(v) || jsonb_build_object('proprietaire', o.nom) ORDER BY v.exercice DESC)
                            FROM v_dossier_fiscal v JOIN proprietaires o ON o.id = v.proprietaire_id
                           WHERE v.parcelle_id = p_parcelle AND (p_exercice IS NULL OR v.exercice = p_exercice)), '[]'),
    'impositions', coalesce((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('regle_code', r.code, 'regle', r.libelle, 'proprietaire', o.nom,
                                 'montant_paye', (SELECT coalesce(sum(pa.montant), 0) FROM paiements pa WHERE pa.imposition_id = i.id),
                                 'paiements', coalesce((SELECT jsonb_agg(to_jsonb(pa) ORDER BY pa.date_paiement) FROM paiements pa WHERE pa.imposition_id = i.id), '[]'))
                               ORDER BY i.exercice DESC, r.code)
                              FROM impositions i JOIN regles_fiscales r ON r.id = i.regle_id JOIN proprietaires o ON o.id = i.proprietaire_id
                             WHERE i.parcelle_id = p_parcelle AND (p_exercice IS NULL OR i.exercice = p_exercice)), '[]'),
    'declarations', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.exercice DESC) FROM declarations d
                               WHERE d.parcelle_id = p_parcelle AND (p_exercice IS NULL OR d.exercice = p_exercice)), '[]'),
    'exonerations', coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.date_debut DESC) FROM exonerations e WHERE e.parcelle_id = p_parcelle), '[]'),
    'arrieres', (SELECT coalesce(sum(solde), 0) FROM v_dossier_fiscal
                  WHERE parcelle_id = p_parcelle AND prochaine_echeance < current_date AND solde > 0));
END $$;

/** Potentiel / liquidé / recouvré / écart par commune. */
CREATE FUNCTION public.fiscalite_synthese(p_exercice int DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.exercice DESC, x.commune) FROM (
    SELECT p.commune_code, t.nom AS commune, v.exercice,
           count(DISTINCT v.parcelle_id)::int AS biens_imposes,
           sum(v.montant_theorique) AS potentiel,
           coalesce(sum(v.montant_liquide), 0) AS liquide,
           sum(v.montant_paye) AS recouvre,
           sum(v.montant_theorique) - sum(v.montant_paye) AS ecart,
           CASE WHEN sum(v.montant_liquide) > 0 THEN round(100 * sum(v.montant_paye) / sum(v.montant_liquide), 1) END AS taux_recouvrement
      FROM v_dossier_fiscal v JOIN parcelles p ON p.id = v.parcelle_id JOIN territoires t ON t.code = p.commune_code
     WHERE (p_exercice IS NULL OR v.exercice = p_exercice) AND snifi.dans_perimetre(u, p.commune_code)
     GROUP BY p.commune_code, t.nom, v.exercice) x), '[]');
END $$;

-- ---------------------------------------------------------------------------
-- Module 06 — Transactions
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.transactions_lister(p_statut text DEFAULT NULL, p_type text DEFAULT NULL, p_page int DEFAULT 1, p_taille int DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); res jsonb;
BEGIN
  SELECT jsonb_build_object('total', coalesce(max(x.total), 0), 'page', p_page,
                            'elements', coalesce(jsonb_agg(to_jsonb(x) - 'total' ORDER BY x.date_evenement DESC), '[]'))
    INTO res
    FROM (SELECT t.*, p.snifi_id AS parcelle_snifi_id, c.nom AS cedant, a.nom AS acquereur,
                 CASE WHEN p.superficie_m2 > 0 THEN round(t.valeur / p.superficie_m2) END AS valeur_m2,
                 count(*) OVER ()::int AS total
            FROM transactions t JOIN parcelles p ON p.id = t.parcelle_id
            LEFT JOIN proprietaires c ON c.id = t.cedant_id LEFT JOIN proprietaires a ON a.id = t.acquereur_id
           WHERE snifi.dans_perimetre(u, p.commune_code)
             AND (p_statut IS NULL OR t.statut = p_statut) AND (p_type IS NULL OR t.type = p_type)
           ORDER BY t.date_evenement DESC LIMIT snifi.taille(p_taille) OFFSET snifi.decalage(p_page, p_taille)) x;
  RETURN res;
END $$;

CREATE FUNCTION public.transaction_creer(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('transactions', NULL, coalesce(p_data ->> 'source_code', 'SNIFI')); r transactions;
BEGIN
  IF p_data ->> 'type' IN ('vente', 'acquisition', 'donation', 'succession', 'mutation', 'transfert_droits')
     AND p_data ->> 'acquereur_id' IS NULL THEN
    PERFORM snifi.erreur('Un acquéreur est requis pour un transfert de droits');
  END IF;
  IF coalesce(p_data ->> 'statut', 'enregistree') NOT IN ('enregistree', 'validee') THEN
    PERFORM snifi.erreur('Statut initial invalide');
  END IF;
  INSERT INTO transactions (type, parcelle_id, date_evenement, valeur, cedant_id, acquereur_id, acteur, document_ref, source_code, statut)
  VALUES (p_data ->> 'type', (p_data ->> 'parcelle_id')::uuid, (p_data ->> 'date_evenement')::date, (p_data ->> 'valeur')::numeric,
          (p_data ->> 'cedant_id')::uuid, (p_data ->> 'acquereur_id')::uuid, p_data ->> 'acteur', p_data ->> 'document_ref',
          coalesce(p_data ->> 'source_code', 'SNIFI'), coalesce(p_data ->> 'statut', 'enregistree'))
  RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.transaction_valider(p_id uuid, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('appliquer', p_motif); r transactions;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  UPDATE transactions SET statut = 'validee' WHERE id = p_id AND statut = 'enregistree' RETURNING * INTO r;
  IF NOT FOUND THEN PERFORM snifi.erreur('Transaction introuvable ou déjà validée'); END IF;
  RETURN to_jsonb(r);
END $$;

/**
 * Répercute l'événement : clôture des droits du cédant et ouverture d'un droit équivalent
 * (même quote-part) pour l'acquéreur, à la date de l'événement.
 */
CREATE FUNCTION public.transaction_appliquer(p_id uuid, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('appliquer', p_motif); t transactions; d record; n int := 0; nclos int;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  SELECT * INTO t FROM transactions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM snifi.erreur('Transaction introuvable'); END IF;
  IF t.statut NOT IN ('enregistree', 'validee') THEN PERFORM snifi.erreur('Transaction déjà ' || t.statut); END IF;

  IF t.type IN ('vente', 'acquisition', 'donation', 'succession', 'mutation', 'transfert_droits') THEN
    IF EXISTS (SELECT 1 FROM droits WHERE parcelle_id = t.parcelle_id AND date_fin IS NULL
                 AND (t.cedant_id IS NULL OR proprietaire_id = t.cedant_id) AND date_debut > t.date_evenement) THEN
      PERFORM snifi.erreur('La date de l''événement est antérieure au droit du cédant : vérification requise');
    END IF;
    CREATE TEMP TABLE IF NOT EXISTS _droits_clos (type_droit text, quote_part numeric) ON COMMIT DROP;
    DELETE FROM _droits_clos;
    WITH clos AS (
      UPDATE droits SET date_fin = t.date_evenement
       WHERE parcelle_id = t.parcelle_id AND date_fin IS NULL AND (t.cedant_id IS NULL OR proprietaire_id = t.cedant_id)
      RETURNING type_droit, quote_part)
    INSERT INTO _droits_clos SELECT * FROM clos;
    GET DIAGNOSTICS nclos = ROW_COUNT;
    IF t.cedant_id IS NOT NULL AND nclos = 0 THEN
      PERFORM snifi.erreur('Le cédant ne détient aucun droit actif sur cette parcelle : vérification requise');
    END IF;
    FOR d IN SELECT type_droit, least(sum(quote_part), 1) AS qp FROM _droits_clos GROUP BY type_droit
             UNION ALL SELECT 'propriete', 1 WHERE nclos = 0 LOOP
      INSERT INTO droits (proprietaire_id, parcelle_id, type_droit, quote_part, date_debut, transaction_id, document_ref, source_code)
      VALUES (t.acquereur_id, t.parcelle_id, d.type_droit, d.qp, t.date_evenement, t.id, t.document_ref, t.source_code);
      n := n + 1;
    END LOOP;
  END IF;
  UPDATE transactions SET statut = 'appliquee', appliquee_le = now() WHERE id = p_id RETURNING * INTO t;
  RETURN to_jsonb(t) || jsonb_build_object('droits_crees', n);
END $$;

-- ---------------------------------------------------------------------------
-- Module 08 — Anomalies
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.anomalies_regles() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object('ouvertes', (
             SELECT count(*) FROM anomalies a JOIN parcelles p ON p.id = a.parcelle_id
              WHERE a.regle_code = r.code AND a.statut IN ('ouverte', 'en_examen') AND snifi.dans_perimetre(u, p.commune_code)))
           ORDER BY r.code) FROM regles_anomalies r), '[]');
END $$;

CREATE FUNCTION public.anomalie_regle_modifier(p_code text, p_motif text, p_actif boolean DEFAULT NULL, p_poids int DEFAULT NULL,
                                               p_parametres jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('regles_ano', p_motif); r regles_anomalies;
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  UPDATE regles_anomalies SET actif = coalesce(p_actif, actif), poids = coalesce(p_poids, poids),
         parametres = parametres || coalesce(p_parametres, '{}') WHERE code = p_code RETURNING * INTO r;
  IF NOT FOUND THEN PERFORM snifi.erreur('Règle introuvable'); END IF;
  RETURN to_jsonb(r);
END $$;

/** Exécute le moteur de rapprochement sur les règles actives (ou une sélection). */
CREATE FUNCTION public.anomalies_executer(p_regles text[] DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('anomalies', 'Exécution du moteur d''anomalies', 'MOTEUR-ANOMALIES'); res jsonb := '[]'; c text;
BEGIN
  FOR c IN SELECT code FROM regles_anomalies WHERE actif AND (p_regles IS NULL OR code = ANY (p_regles)) ORDER BY code LOOP
    res := res || jsonb_build_array(snifi.executer_regle_anomalie(c));
  END LOOP;
  RETURN jsonb_build_object('execute_le', now(), 'resultats', res);
END $$;

CREATE FUNCTION public.anomalies_lister(p_statut text DEFAULT NULL, p_regle text DEFAULT NULL, p_gravite text DEFAULT NULL,
                                        p_commune text DEFAULT NULL, p_page int DEFAULT 1, p_taille int DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); res jsonb;
BEGIN
  SELECT jsonb_build_object('total', coalesce(max(x.total), 0), 'page', p_page,
                            'elements', coalesce(jsonb_agg(to_jsonb(x) - 'total' - 'ordre' ORDER BY x.ordre, x.detectee_le DESC), '[]'))
    INTO res
    FROM (SELECT a.*, r.libelle, p.snifi_id AS parcelle_snifi_id, p.commune_code, o.nom AS proprietaire,
                 CASE a.gravite WHEN 'elevee' THEN 0 WHEN 'moyenne' THEN 1 ELSE 2 END AS ordre,
                 count(*) OVER ()::int AS total
            FROM anomalies a JOIN regles_anomalies r ON r.code = a.regle_code
            JOIN parcelles p ON p.id = a.parcelle_id LEFT JOIN proprietaires o ON o.id = a.proprietaire_id
           WHERE snifi.dans_perimetre(u, p.commune_code)
             AND (p_statut IS NULL OR a.statut = p_statut) AND (p_regle IS NULL OR a.regle_code = p_regle)
             AND (p_gravite IS NULL OR a.gravite = p_gravite) AND (p_commune IS NULL OR p.commune_code = p_commune)
           ORDER BY CASE a.gravite WHEN 'elevee' THEN 0 WHEN 'moyenne' THEN 1 ELSE 2 END, a.detectee_le DESC
           LIMIT snifi.taille(p_taille) OFFSET snifi.decalage(p_page, p_taille)) x;
  RETURN res;
END $$;

/** Cycle de traitement : une anomalie clôturée ne peut pas être rouverte silencieusement. */
CREATE FUNCTION public.anomalie_traiter(p_id uuid, p_statut text, p_motif text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('anomalies', p_motif); v_actuel text; r anomalies;
        transitions jsonb := '{"ouverte": ["en_examen", "rejetee"], "en_examen": ["confirmee", "rejetee", "corrigee"],
                               "confirmee": ["cloturee"], "rejetee": ["cloturee"], "corrigee": ["cloturee"], "cloturee": []}';
BEGIN
  PERFORM snifi.exiger_motif(p_motif);
  SELECT statut INTO v_actuel FROM anomalies WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM snifi.erreur('Anomalie introuvable'); END IF;
  IF NOT (transitions -> v_actuel) ? p_statut THEN
    PERFORM snifi.erreur('Transition non autorisée : ' || v_actuel || ' → ' || p_statut);
  END IF;
  UPDATE anomalies SET statut = p_statut, commentaire = p_motif, traitee_le = now(), traitee_par = u.login
   WHERE id = p_id RETURNING * INTO r;
  RETURN to_jsonb(r);
END $$;

-- ---------------------------------------------------------------------------
-- Journal d'audit
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.audit_journal(p_table text DEFAULT NULL, p_utilisateur text DEFAULT NULL, p_ligne text DEFAULT NULL,
                                     p_page int DEFAULT 1, p_taille int DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('audit');
BEGIN
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id DESC) FROM (
    SELECT * FROM journal_audit
     WHERE (p_table IS NULL OR table_nom = p_table) AND (p_utilisateur IS NULL OR utilisateur ILIKE '%' || p_utilisateur || '%')
       AND (p_ligne IS NULL OR ligne_id = p_ligne)
     ORDER BY id DESC LIMIT snifi.taille(p_taille) OFFSET snifi.decalage(p_page, p_taille)) j), '[]');
END $$;

/** Vérifie la chaîne de hachage : toute altération a posteriori est détectée. */
CREATE FUNCTION public.audit_verifier() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('audit'); rupture jsonb;
BEGIN
  SELECT to_jsonb(v) INTO rupture FROM verifier_journal() v;
  RETURN jsonb_build_object('integre', rupture IS NULL, 'rupture', rupture,
                            'entrees', (SELECT count(*) FROM journal_audit), 'derniere_entree', (SELECT max(id) FROM journal_audit));
END $$;

-- ---------------------------------------------------------------------------
-- Tableau de bord (Module 13) et espace propriétaire
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.tableau_de_bord(p_exercice int DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('lecture'); ex int := coalesce(p_exercice, extract(year FROM current_date)::int);
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _perimetre (id uuid PRIMARY KEY, commune_code text) ON COMMIT DROP;
  DELETE FROM _perimetre;
  INSERT INTO _perimetre SELECT id, commune_code FROM parcelles WHERE snifi.dans_perimetre(u, commune_code);
  RETURN jsonb_build_object(
    'exercice', ex,
    'indicateurs', jsonb_build_object(
      'parcelles', (SELECT count(*) FROM _perimetre),
      'batiments', (SELECT count(*) FROM batiments b JOIN _perimetre p ON p.id = b.parcelle_id),
      'unites', (SELECT count(*) FROM unites un JOIN batiments b ON b.id = un.batiment_id JOIN _perimetre p ON p.id = b.parcelle_id),
      'proprietaires', (SELECT count(DISTINCT d.proprietaire_id) FROM droits d JOIN _perimetre p ON p.id = d.parcelle_id WHERE d.date_fin IS NULL),
      'biens_imposables', (SELECT count(DISTINCT i.parcelle_id) FROM impositions i JOIN _perimetre p ON p.id = i.parcelle_id WHERE i.exercice = ex),
      'potentiel', (SELECT coalesce(sum(v.montant_theorique), 0) FROM v_dossier_fiscal v JOIN _perimetre p ON p.id = v.parcelle_id WHERE v.exercice = ex),
      'liquide', (SELECT coalesce(sum(v.montant_liquide), 0) FROM v_dossier_fiscal v JOIN _perimetre p ON p.id = v.parcelle_id WHERE v.exercice = ex),
      'recouvre', (SELECT coalesce(sum(v.montant_paye), 0) FROM v_dossier_fiscal v JOIN _perimetre p ON p.id = v.parcelle_id WHERE v.exercice = ex),
      'arrieres', (SELECT coalesce(sum(v.solde), 0) FROM v_dossier_fiscal v JOIN _perimetre p ON p.id = v.parcelle_id
                    WHERE v.prochaine_echeance < current_date AND v.solde > 0),
      'anomalies_ouvertes', (SELECT count(*) FROM anomalies a JOIN _perimetre p ON p.id = a.parcelle_id WHERE a.statut IN ('ouverte', 'en_examen'))),
    'anomalies', (SELECT jsonb_agg(jsonb_build_object('code', r.code, 'libelle', r.libelle, 'gravite', r.gravite,
                     'ouvertes', (SELECT count(*) FROM anomalies a JOIN _perimetre p ON p.id = a.parcelle_id
                                   WHERE a.regle_code = r.code AND a.statut IN ('ouverte', 'en_examen'))) ORDER BY r.code)
                    FROM regles_anomalies r),
    'communes', coalesce((SELECT jsonb_agg(jsonb_build_object('commune_code', c.commune_code, 'nom', t.nom, 'parcelles', c.n,
                     'parcelles_baties', c.baties, 'anomalies', c.ano) ORDER BY t.nom)
                    FROM (SELECT p.commune_code, count(*) AS n,
                                 count(*) FILTER (WHERE EXISTS (SELECT 1 FROM batiments b WHERE b.parcelle_id = p.id)) AS baties,
                                 (SELECT count(*) FROM anomalies a JOIN _perimetre p2 ON p2.id = a.parcelle_id
                                   WHERE p2.commune_code = p.commune_code AND a.statut IN ('ouverte', 'en_examen')) AS ano
                            FROM _perimetre p GROUP BY p.commune_code) c JOIN territoires t ON t.code = c.commune_code), '[]'),
    'usages', coalesce((SELECT jsonb_agg(jsonb_build_object('usage', x.usage, 'batiments', x.n, 'surface_m2', x.s) ORDER BY x.n DESC)
                    FROM (SELECT b.usage, count(*) AS n, sum(b.surface_m2) AS s FROM batiments b JOIN _perimetre p ON p.id = b.parcelle_id
                           GROUP BY b.usage) x), '[]'));
END $$;

CREATE FUNCTION public.espace_proprietaire_biens() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = snifi, public, extensions AS $$
DECLARE u snifi.profils := snifi.ctx('tous');
BEGIN
  IF u.role <> 'proprietaire' THEN RAISE EXCEPTION 'Réservé aux propriétaires' USING ERRCODE = 'SN403'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'snifi_id', p.snifi_id, 'commune_code', p.commune_code,
            'quartier', p.quartier, 'superficie_m2', p.superficie_m2, 'type_droit', d.type_droit, 'quote_part', d.quote_part,
            'date_debut', d.date_debut,
            'fiscalite', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.exercice DESC) FROM v_dossier_fiscal v
                           WHERE v.parcelle_id = p.id AND v.proprietaire_id = u.proprietaire_id)))
           FROM droits d JOIN parcelles p ON p.id = d.parcelle_id
          WHERE d.proprietaire_id = u.proprietaire_id AND d.date_fin IS NULL), '[]');
END $$;

-- ---------------------------------------------------------------------------
-- Droits d'exécution : uniquement les utilisateurs authentifiés.
-- Toutes les fonctions internes du schéma snifi s'exécutent avec un search_path figé.
-- ---------------------------------------------------------------------------
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, n.nspname, p.proname
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'snifi'
               OR (n.nspname = 'public' AND p.proname IN (
                   'moi', 'proprietaires_lister', 'proprietaire_detail', 'proprietaire_creer', 'proprietaire_modifier',
                   'proprietaire_fusionner', 'parcelles_lister', 'parcelle_detail', 'parcelle_historique', 'parcelle_creer',
                   'parcelle_modifier', 'droit_ajouter', 'batiment_detail', 'batiment_creer', 'batiment_modifier', 'unite_ajouter',
                   'permis_creer', 'carto_parcelles', 'carto_batiments', 'carto_zones_fiscales', 'carto_territoires',
                   'fiscalite_regles', 'regle_fiscale_creer', 'fiscalite_calculer', 'fiscalite_liquider', 'paiement_enregistrer',
                   'exoneration_creer', 'dossier_fiscal', 'fiscalite_synthese', 'transactions_lister', 'transaction_creer',
                   'transaction_valider', 'transaction_appliquer', 'anomalies_regles', 'anomalie_regle_modifier',
                   'anomalies_executer', 'anomalies_lister', 'anomalie_traiter', 'audit_journal', 'audit_verifier',
                   'tableau_de_bord', 'espace_proprietaire_biens'))
  LOOP
    IF f.nspname = 'snifi' THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = snifi, public, extensions', f.sig);
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    ELSE
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.sig);
    END IF;
  END LOOP;
END $$;
