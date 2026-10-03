'use client';

export interface Utilisateur {
  id: string;
  login: string;
  nom: string;
  role: string;
  territoire_code: string | null;
}

const CLE = 'snifi.session';

export function session(): { jeton: string; utilisateur: Utilisateur } | null {
  try {
    const s = localStorage.getItem(CLE);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function ouvrirSession(jeton: string, utilisateur: Utilisateur) {
  localStorage.setItem(CLE, JSON.stringify({ jeton, utilisateur }));
}

export function fermerSession() {
  localStorage.removeItem(CLE);
}

export class ErreurApi extends Error {
  constructor(public statut: number, message: string, public erreurs?: { champ: string; message: string }[]) {
    super(message);
  }
}

export async function api<T = any>(chemin: string, options: { methode?: string; corps?: unknown } = {}): Promise<T> {
  const s = session();
  const res = await fetch(`/api/v1${chemin}`, {
    method: options.methode ?? (options.corps ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(s ? { Authorization: `Bearer ${s.jeton}` } : {}),
    },
    body: options.corps ? JSON.stringify(options.corps) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && s) {
    fermerSession();
    window.location.href = '/connexion';
  }
  if (!res.ok) {
    const detail = data.erreurs?.map((e: any) => `${e.champ} : ${e.message}`).join(' · ');
    throw new ErreurApi(res.status, detail ? `${data.message} — ${detail}` : data.message ?? `Erreur ${res.status}`, data.erreurs);
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
