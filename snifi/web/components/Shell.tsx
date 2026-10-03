'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { fermerSession, libelle, session, Utilisateur } from '@/lib/api';

const LIENS = [
  ['/', 'Tableau de bord'],
  ['/carte', 'Cartographie'],
  ['/parcelles', 'Parcelles'],
  ['/proprietaires', 'Propriétaires'],
  ['/transactions', 'Transactions'],
  ['/fiscalite', 'Fiscalité'],
  ['/anomalies', 'Anomalies'],
  ['/audit', 'Journal d’audit'],
];

export default function Shell({ children }: { children: ReactNode }) {
  const chemin = usePathname();
  const router = useRouter();
  const [u, setU] = useState<Utilisateur | null>(null);
  const [pret, setPret] = useState(false);

  useEffect(() => {
    const s = session();
    if (!s && chemin !== '/connexion') router.replace('/connexion');
    setU(s?.utilisateur ?? null);
    setPret(true);
  }, [chemin, router]);

  if (chemin === '/connexion') return <>{children}</>;
  if (!pret || !u) return null;

  return (
    <div className="app">
      <nav className="nav">
        <div className="marque">SNIFI<small>Système National d’Intelligence Fiscale Immobilière</small></div>
        {LIENS.map(([href, lib]) => (
          <Link key={href} href={href} className={(href === '/' ? chemin === '/' : chemin.startsWith(href)) ? 'actif' : ''}>{lib}</Link>
        ))}
        <div className="pied">
          <div><strong>{u.nom}</strong></div>
          <div>{libelle(u.role)}{u.territoire_code ? ` · ${u.territoire_code}` : ''}</div>
          <a href="#" onClick={(e) => { e.preventDefault(); fermerSession(); router.replace('/connexion'); }}>Se déconnecter</a>
        </div>
      </nav>
      <main className="contenu">{children}</main>
    </div>
  );
}
