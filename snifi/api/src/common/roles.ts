export type Role =
  | 'admin_national' | 'admin_regional' | 'agent_fiscal' | 'controleur' | 'collectivite'
  | 'service_foncier' | 'urbanisme' | 'notaire' | 'promoteur' | 'proprietaire' | 'auditeur' | 'admin_technique';

/** Profils institutionnels autorisés à consulter le référentiel (lecture). */
export const LECTURE: Role[] = [
  'admin_national', 'admin_regional', 'agent_fiscal', 'controleur', 'collectivite',
  'service_foncier', 'urbanisme', 'auditeur',
];

/** Matrice des droits d'écriture — principe du moindre privilège. */
export const ECRITURE = {
  proprietaires: ['admin_national', 'admin_regional', 'agent_fiscal', 'service_foncier'] as Role[],
  parcelles: ['admin_national', 'service_foncier'] as Role[],
  batiments: ['admin_national', 'service_foncier', 'urbanisme', 'agent_fiscal'] as Role[],
  permis: ['admin_national', 'urbanisme'] as Role[],
  transactions: ['admin_national', 'service_foncier', 'notaire'] as Role[],
  appliquerTransaction: ['admin_national', 'service_foncier'] as Role[],
  reglesFiscales: ['admin_national'] as Role[],
  fiscalite: ['admin_national', 'agent_fiscal'] as Role[],
  anomaliesExecution: ['admin_national', 'controleur', 'agent_fiscal'] as Role[],
  anomaliesTraitement: ['admin_national', 'controleur', 'agent_fiscal'] as Role[],
  reglesAnomalies: ['admin_national'] as Role[],
  audit: ['admin_national', 'auditeur'] as Role[],
};

export interface UtilisateurCourant {
  id: string;
  login: string;
  nom: string;
  role: Role;
  territoire_code: string | null;
  proprietaire_id: string | null;
}
