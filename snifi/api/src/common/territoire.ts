import { UtilisateurCourant } from './roles';

/**
 * Restreint une requête au périmètre territorial de l'utilisateur (admin régional, agent, collectivité).
 * Ajoute le paramètre à `params` et renvoie la condition SQL (ou 'true' si accès national).
 */
export function filtreTerritoire(u: UtilisateurCourant, colonne: string, params: unknown[]): string {
  if (!u.territoire_code) return 'true';
  params.push(u.territoire_code);
  return `(${colonne} = $${params.length} OR ${colonne} LIKE $${params.length} || '-%')`;
}
