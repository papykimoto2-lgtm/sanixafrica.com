-- Simulation minimale de Supabase Auth pour les tests locaux (NE PAS appliquer sur Supabase).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;
INSERT INTO auth.users (email) VALUES
  ('admin@snifi.demo'), ('agent@snifi.demo'), ('controleur@snifi.demo'), ('foncier@snifi.demo'), ('auditeur@snifi.demo');
