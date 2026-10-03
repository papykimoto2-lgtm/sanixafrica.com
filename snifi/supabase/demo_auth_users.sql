-- SNIFI — Comptes de démonstration dans Supabase Auth (à exécuter AVANT seed.sql).
-- Mot de passe commun : snifi2026. À NE PAS utiliser en production.
-- En production, les comptes sont créés depuis le tableau de bord Supabase (Authentication)
-- ou par invitation, puis un administrateur leur attribue un profil dans snifi.profils.
DO $$
DECLARE e text; uid uuid;
BEGIN
  FOREACH e IN ARRAY ARRAY['admin@snifi.demo', 'agent@snifi.demo', 'controleur@snifi.demo', 'foncier@snifi.demo', 'auditeur@snifi.demo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = e) THEN
      uid := gen_random_uuid();
      INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', e,
              extensions.crypt('snifi2026', extensions.gen_salt('bf')), now(),
              '{"provider": "email", "providers": ["email"]}', '{}', now(), now(), '', '', '', '');
      INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      VALUES (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', e, 'email_verified', true),
              'email', now(), now(), now());
    END IF;
  END LOOP;
END $$;
