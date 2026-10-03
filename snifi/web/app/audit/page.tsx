'use client';

import { useState } from 'react';
import { Erreur, useRpc } from '@/components/ui';
import { fmt } from '@/lib/api';

export default function Audit() {
  const [table, setTable] = useState('');
  const [page, setPage] = useState(1);
  const { data, erreur } = useRpc('audit_journal', { p_page: page, p_taille: 50, p_table: table });
  const { data: verif, recharger } = useRpc('audit_verifier');

  return (
    <>
      <h1>Journal d’audit</h1>
      <p className="sous-titre">Journal en ajout seul, chaîné par empreintes SHA-256 : aucune donnée historique ne peut être modifiée silencieusement.</p>
      {verif && (
        <div className={`message ${verif.integre ? 'info' : 'erreur'}`}>
          {verif.integre
            ? `Chaîne intègre — ${verif.entrees.toLocaleString('fr-FR')} entrées vérifiées.`
            : `Rupture d’intégrité détectée à l’entrée n° ${verif.rupture.id} !`}{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); recharger(); }}>Revérifier</a>
        </div>
      )}
      <div className="barre-outils">
        <select value={table} onChange={(e) => { setTable(e.target.value); setPage(1); }}>
          <option value="">Toutes les tables</option>
          {['parcelles', 'proprietaires', 'droits', 'batiments', 'unites', 'transactions', 'impositions', 'paiements', 'anomalies', 'regles_fiscales', 'regles_anomalies', 'utilisateurs']
            .map((t) => <option key={t}>{t}</option>)}
        </select>
        <button className="secondaire" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button>
        <button className="secondaire" disabled={!data || data.length < 50} onClick={() => setPage(page + 1)}>Suivant</button>
      </div>
      <Erreur message={erreur} />
      <div className="panneau table-scroll">
        <table>
          <thead><tr><th>N°</th><th>Quand</th><th>Qui</th><th>Quoi</th><th>Modification</th><th>Pourquoi</th><th>Source</th><th>Empreinte</th></tr></thead>
          <tbody>
            {data?.map((e: any) => (
              <tr key={e.id}>
                <td>{e.id}</td><td>{fmt.dateHeure(e.horodatage)}</td><td>{e.utilisateur}</td>
                <td>{e.action} {e.table_nom}</td>
                <td><small>{e.action === 'UPDATE'
                  ? e.champs?.map((c: string) => `${c} : ${fmtVal(e.avant?.[c])} → ${fmtVal(e.apres?.[c])}`).join(' · ')
                  : `ligne ${e.ligne_id?.slice(0, 8)}…`}</small></td>
                <td>{e.motif ?? '—'}</td><td>{e.source ?? '—'}</td><td><code>{e.hash.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function fmtVal(v: unknown) {
  if (v === null || v === undefined) return '∅';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}
