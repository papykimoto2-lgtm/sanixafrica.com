'use client';

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'cle-manquante',
);

export interface Utilisateur {
  user_id: string;
  login: string;
  nom: string;
  role: string;
  territoire_code: string | null;
}

/** Messages lisibles pour les codes d'erreur PostgreSQL non métier. */
const ERREURS_PG: Record<string, string> = {
  '23505': 'Doublon : un enregistrement avec cet identifiant existe déjà',
  '23503': 'Référence inexistante',
  '23514': 'Valeur non conforme aux contraintes du référentiel',
  '22P02': 'Format de donnée invalide',
  '22007': 'Date invalide',
  '42501': 'Accès refusé',
};

/** Appelle une fonction de l'API SNIFI (RPC Supabase) avec la session de l'utilisateur. */
export async function rpc<T = any>(fonction: string, args: Record<string, unknown> = {}): Promise<T> {
  const propres = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ''));
  const { data, error } = await supabase.rpc(fonction, propres);
  if (error) {
    if (error.code === 'SN401' || error.code === 'PGRST301') {
      await supabase.auth.signOut();
      window.location.href = '/connexion';
    }
    throw new Error(error.code?.startsWith('SN') ? error.message : ERREURS_PG[error.code] ?? error.message);
  }
  return data as T;
}

export const fmt = {
  nombre: (n: unknown) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('fr-FR')),
  montant: (n: unknown) =>
    n === null || n === undefined ? '—' : `${Math.round(Number(n)).toLocaleString('fr-FR')} FCFA`,
  m2: (n: unknown) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('fr-FR')} m²`),
  date: (d: unknown) => (d ? new Date(String(d)).toLocaleDateString('fr-FR') : '—'),
  dateHeure: (d: unknown) => (d ? new Date(String(d)).toLocaleString('fr-FR') : '—'),
};

export const LIBELLES: Record<string, string> = {
  ouverte: 'Ouverte', en_examen: 'En examen', confirmee: 'Confirmée', rejetee: 'Rejetée', corrigee: 'Corrigée', cloturee: 'Clôturée',
  faible: 'Faible', moyenne: 'Moyenne', elevee: 'Élevée',
  calculee: 'Calculée', liquidee: 'Liquidée', soldee: 'Soldée', annulee: 'Annulée',
  enregistree: 'Enregistrée', validee: 'Validée', appliquee: 'Appliquée',
  personne_physique: 'Personne physique', personne_morale: 'Personne morale', copropriete: 'Copropriété',
  succession: 'Succession', etat: 'État', collectivite: 'Collectivité', autre: 'Autre',
  admin_national: 'Administrateur national', agent_fiscal: 'Agent fiscal', controleur: 'Contrôleur',
  service_foncier: 'Service foncier', auditeur: 'Auditeur',
};
export const libelle = (k: unknown) => LIBELLES[String(k)] ?? String(k ?? '—');
