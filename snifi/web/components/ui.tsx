'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, libelle } from '@/lib/api';

/** Charge une ressource de l'API et expose { data, erreur, recharger }. */
export function useApi<T = any>(chemin: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const recharger = useCallback(() => {
    if (!chemin) return;
    setErreur(null);
    api<T>(chemin).then(setData).catch((e) => setErreur(e.message));
  }, [chemin]);
  useEffect(recharger, [recharger]);
  return { data, erreur, recharger };
}

export function Badge({ v, classe }: { v: unknown; classe?: string }) {
  return <span className={`badge ${classe ?? String(v)}`}>{libelle(v)}</span>;
}

export function Erreur({ message }: { message: string | null }) {
  return message ? <div className="message erreur">{message}</div> : null;
}

export function Pagination({ page, taille, total, onPage }: { page: number; taille: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / taille));
  return (
    <div className="pagination">
      <span>{total.toLocaleString('fr-FR')} résultat(s) · page {page}/{pages}</span>
      <button className="secondaire" disabled={page <= 1} onClick={() => onPage(page - 1)}>Précédent</button>
      <button className="secondaire" disabled={page >= pages} onClick={() => onPage(page + 1)}>Suivant</button>
    </div>
  );
}

/** Demande le motif exigé par la traçabilité SNIFI avant toute modification. */
export function demanderMotif(action: string): string | null {
  const m = window.prompt(`Motif de l’opération « ${action} » (obligatoire, tracé dans le journal d’audit) :`);
  return m && m.trim().length >= 5 ? m.trim() : (m === null ? null : (alert('Le motif doit comporter au moins 5 caractères.'), null));
}
