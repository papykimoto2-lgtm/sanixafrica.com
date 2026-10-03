'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { libelle, rpc, supabase, Utilisateur } from '@/lib/api';

const LIENS: [string, string, string[]?][] = [
  ['/', 'Tableau de bord'],
  ['/carte', 'Cartographie'],
  ['/parcelles', 'Parcelles'],
  ['/proprietaires', 'Propriétaires'],
  ['/transactions', 'Transactions'],
  ['/fiscalite', 'Fiscalité'],
  ['/anomalies', 'Anomalies'],
  ['/audit', 'Journal d’audit', ['admin_national', 'auditeur']],
];

export default function Shell({ children }: { children: ReactNode }) {
  const chemin = usePathname();
  const router = useRouter();
  const [u, setU] = useState<Utilisateur | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (chemin === '/connexion') return;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return router.replace('/connexion');
      try {
        setU(await rpc<Utilisateur>('moi'));
      } catch (e: any) {
        setErreur(e.message);
      }
    });
    const { data: abonnement } = supabase.auth.onAuthStateChange((evt) => {
      if (evt === 'SIGNED_OUT') router.replace('/connexion');
    });
    return () => abonnement.subscription.unsubscribe();
  }, [chemin, router]);

  if (chemin === '/connexion') return <>{children}</>;
  if (erreur) return <div className="connexion"><div className="panneau"><div className="message erreur">{erreur}</div>
    <button onClick={() => supabase.auth.signOut()}>Changer de compte</button></div></div>;
  if (!u) return null;

  return (
    <div className="app">
      <nav className="nav">
        <div className="marque">SNIFI<small>Système National d’Intelligence Fiscale Immobilière</small></div>
        {LIENS.filter(([, , roles]) => !roles || roles.includes(u.role)).map(([href, lib]) => (
          <Link key={href} href={href} className={(href === '/' ? chemin === '/' : chemin.startsWith(href)) ? 'actif' : ''}>{lib}</Link>
        ))}
        <div className="pied">
          <div><strong>{u.nom}</strong></div>
          <div>{libelle(u.role)}{u.territoire_code ? ` · ${u.territoire_code}` : ''}</div>
          <a href="#" onClick={(e) => { e.preventDefault(); supabase.auth.signOut(); }}>Se déconnecter</a>
        </div>
      </nav>
      <main className="contenu">{children}</main>
    </div>
  );
}
