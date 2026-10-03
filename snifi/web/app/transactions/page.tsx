'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, demanderMotif, Erreur, Pagination, useApi } from '@/components/ui';
import { api, fmt } from '@/lib/api';

export default function Transactions() {
  const [page, setPage] = useState(1);
  const [statut, setStatut] = useState('');
  const { data, erreur, recharger } = useApi(`/transactions?page=${page}&taille=25${statut ? `&statut=${statut}` : ''}`);
  const [err, setErr] = useState<string | null>(null);

  async function action(id: string, verbe: 'valider' | 'appliquer') {
    const motif = demanderMotif(verbe === 'appliquer' ? 'répercussion dans les droits' : 'validation');
    if (!motif) return;
    setErr(null);
    try {
      await api(`/transactions/${id}/${verbe}`, { corps: { motif } });
      recharger();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  return (
    <>
      <h1>Transactions et mutations</h1>
      <p className="sous-titre">Ventes, donations, successions, subdivisions… Chaque événement est daté, sourcé et tracé.</p>
      <div className="barre-outils">
        <select value={statut} onChange={(e) => { setStatut(e.target.value); setPage(1); }}>
          <option value="">Tous les statuts</option>
          <option value="enregistree">Enregistrée</option>
          <option value="validee">Validée (non répercutée)</option>
          <option value="appliquee">Appliquée</option>
        </select>
      </div>
      <Erreur message={erreur ?? err} />
      <div className="panneau table-scroll">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Parcelle</th><th>Cédant → acquéreur</th><th className="num">Valeur</th>
            <th className="num">Valeur/m²</th><th>Source</th><th>Statut</th><th /></tr></thead>
          <tbody>
            {data?.elements.map((t: any) => (
              <tr key={t.id}>
                <td>{fmt.date(t.date_evenement)}</td><td>{t.type}</td>
                <td><Link href={`/parcelles/${t.parcelle_id}`}>{t.parcelle_snifi_id}</Link></td>
                <td>{t.cedant ?? '—'} → {t.acquereur ?? '—'}</td>
                <td className="num">{fmt.montant(t.valeur)}</td><td className="num">{fmt.nombre(t.valeur_m2)}</td>
                <td>{t.source_code}</td><td><Badge v={t.statut} classe={t.statut === 'appliquee' ? 'ok' : 'alerte'} /></td>
                <td>
                  {t.statut === 'enregistree' && <button className="secondaire" onClick={() => action(t.id, 'valider')}>Valider</button>}{' '}
                  {['enregistree', 'validee'].includes(t.statut) && <button onClick={() => action(t.id, 'appliquer')}>Appliquer</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <Pagination page={page} taille={25} total={data.total} onPage={setPage} />}
      </div>
    </>
  );
}
