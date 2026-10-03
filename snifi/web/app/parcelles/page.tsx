'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Erreur, Pagination, useApi } from '@/components/ui';
import { fmt } from '@/lib/api';

function Liste() {
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const [proprietaire, setProprietaire] = useState('');
  const [commune, setCommune] = useState(params.get('commune') ?? '');
  const [page, setPage] = useState(1);
  const [filtre, setFiltre] = useState({ q: '', proprietaire: '' });
  const qs = new URLSearchParams({ page: String(page), taille: '25', ...(filtre.q && { q: filtre.q }),
    ...(filtre.proprietaire && { proprietaire: filtre.proprietaire }), ...(commune && { commune }) });
  const { data, erreur } = useApi(`/parcelles?${qs}`);

  return (
    <>
      <h1>Référentiel parcellaire</h1>
      <p className="sous-titre">Chaque parcelle possède un Identifiant Immobilier SNIFI unique.</p>
      <form className="barre-outils" onSubmit={(e) => { e.preventDefault(); setPage(1); setFiltre({ q, proprietaire }); }}>
        <input placeholder="Identifiant, référence cadastrale, titre, quartier" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <input placeholder="Propriétaire" value={proprietaire} onChange={(e) => setProprietaire(e.target.value)} />
        <select value={commune} onChange={(e) => { setCommune(e.target.value); setPage(1); }}>
          <option value="">Toutes les communes</option>
          <option value="CI-ABJ-COC">Cocody</option>
          <option value="CI-ABJ-YOP">Yopougon</option>
        </select>
        <button type="submit">Rechercher</button>
      </form>
      <Erreur message={erreur} />
      <div className="panneau table-scroll">
        <table>
          <thead>
            <tr><th>Identifiant SNIFI</th><th>Réf. cadastrale</th><th>Commune / quartier</th><th>Propriétaire(s)</th>
              <th className="num">Superficie</th><th className="num">Bâtiments</th><th className="num">Anomalies</th></tr>
          </thead>
          <tbody>
            {data?.elements.map((p: any) => (
              <tr key={p.id}>
                <td><Link href={`/parcelles/${p.id}`}>{p.snifi_id}</Link></td>
                <td>{p.ref_cadastrale}</td>
                <td>{p.commune} · {p.quartier}</td>
                <td>{p.proprietaires ?? '—'}</td>
                <td className="num">{fmt.m2(p.superficie_m2)}</td>
                <td className="num">{p.nb_batiments}</td>
                <td className="num">{p.nb_anomalies > 0 ? <span className="badge elevee">{p.nb_anomalies}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <Pagination page={page} taille={25} total={data.total} onPage={setPage} />}
      </div>
    </>
  );
}

export default function Parcelles() {
  return <Suspense><Liste /></Suspense>;
}
