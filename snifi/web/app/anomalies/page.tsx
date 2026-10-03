'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge, demanderMotif, Erreur, Pagination, useRpc } from '@/components/ui';
import { rpc, fmt, libelle } from '@/lib/api';

const SUIVANTS: Record<string, string[]> = {
  ouverte: ['en_examen', 'rejetee'],
  en_examen: ['confirmee', 'rejetee', 'corrigee'],
  confirmee: ['cloturee'], rejetee: ['cloturee'], corrigee: ['cloturee'], cloturee: [],
};

function Liste() {
  const params = useSearchParams();
  const [regle, setRegle] = useState(params.get('regle') ?? '');
  const [statut, setStatut] = useState('ouverte');
  const [page, setPage] = useState(1);
  const { data, erreur, recharger } = useRpc('anomalies_lister', { p_page: page, p_taille: 25, p_regle: regle, p_statut: statut });
  const { data: regles, recharger: rechargerRegles } = useRpc('anomalies_regles');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function executer() {
    setErr(null);
    try {
      const r = await rpc('anomalies_executer');
      setMsg(r.resultats.map((x: any) => `${x.regle} : ${x.detectees} détectée(s), ${x.nouvelles} nouvelle(s), ${x.corrigees} corrigée(s)`).join(' · '));
      recharger(); rechargerRegles();
    } catch (e: any) { setErr(e.message); }
  }

  async function traiter(id: string, nouveau: string) {
    const motif = demanderMotif(`passage en « ${libelle(nouveau)} »`);
    if (!motif) return;
    setErr(null);
    try { await rpc('anomalie_traiter', { p_id: id, p_statut: nouveau, p_motif: motif }); recharger(); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <>
      <h1>Moteur de rapprochement et d’anomalies</h1>
      <p className="sous-titre">Croisement des sources autorisées (cadastre, urbanisme, notaires, déclarations).</p>
      <p className="avertissement">
        SNIFI ne qualifie pas une anomalie de fraude : il fournit des éléments objectifs permettant à l’administration compétente
        de décider d’une vérification.
      </p>
      <section className="panneau table-scroll">
        <div className="barre-outils"><h2 style={{ margin: 0, flex: 1 }}>Bibliothèque de règles</h2><button onClick={executer}>Exécuter le moteur</button></div>
        {msg && <div className="message info">{msg}</div>}
        <table>
          <thead><tr><th>Code</th><th>Règle</th><th>Gravité</th><th>Paramètres</th><th className="num">Ouvertes</th><th>Active</th></tr></thead>
          <tbody>
            {regles?.map((r: any) => (
              <tr key={r.code}>
                <td>{r.code}</td><td><strong>{r.libelle}</strong><br /><small>{r.description}</small></td>
                <td><Badge v={r.gravite} /></td><td><small>{Object.entries(r.parametres).map(([k, v]) => `${k} = ${v}`).join(', ')}</small></td>
                <td className="num"><a href="#" onClick={(e) => { e.preventDefault(); setRegle(r.code); setPage(1); }}>{r.ouvertes}</a></td>
                <td>{r.actif ? 'oui' : 'non'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <div className="barre-outils">
        <select value={regle} onChange={(e) => { setRegle(e.target.value); setPage(1); }}>
          <option value="">Toutes les règles</option>
          {regles?.map((r: any) => <option key={r.code} value={r.code}>{r.code} — {r.libelle}</option>)}
        </select>
        <select value={statut} onChange={(e) => { setStatut(e.target.value); setPage(1); }}>
          <option value="">Tous les statuts</option>
          {Object.keys(SUIVANTS).map((s) => <option key={s} value={s}>{libelle(s)}</option>)}
        </select>
      </div>
      <Erreur message={erreur ?? err} />
      <div className="panneau table-scroll">
        <table>
          <thead><tr><th>Règle</th><th>Gravité</th><th>Parcelle</th><th>Propriétaire</th><th>Éléments objectifs</th><th>Statut</th><th>Détectée</th><th>Traitement</th></tr></thead>
          <tbody>
            {data?.elements.map((a: any) => (
              <tr key={a.id}>
                <td>{a.regle_code}<br /><small>{a.libelle}</small></td><td><Badge v={a.gravite} /></td>
                <td>{a.parcelle_id ? <Link href={`/parcelles/${a.parcelle_id}`}>{a.parcelle_snifi_id}</Link> : '—'}</td>
                <td>{a.proprietaire ?? '—'}</td>
                <td><small>{Object.entries(a.details).filter(([k]) => k !== 'sources').map(([k, v]) => `${k} : ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</small></td>
                <td><Badge v={a.statut} classe="neutre" />{a.commentaire && <><br /><small>{a.commentaire}</small></>}</td>
                <td>{fmt.date(a.detectee_le)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{SUIVANTS[a.statut].map((s) => (
                  <button key={s} className="secondaire" style={{ marginRight: 4, padding: '3px 8px' }} onClick={() => traiter(a.id, s)}>{libelle(s)}</button>
                ))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <Pagination page={page} taille={25} total={data.total} onPage={setPage} />}
      </div>
    </>
  );
}

export default function Anomalies() {
  return <Suspense><Liste /></Suspense>;
}
