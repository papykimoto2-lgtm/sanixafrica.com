'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, demanderMotif, Erreur, useApi } from '@/components/ui';
import { api, fmt, libelle } from '@/lib/api';

export default function FicheProprietaire() {
  const { id } = useParams<{ id: string }>();
  const { data: p, erreur, recharger } = useApi(`/proprietaires/${id}`);
  const [doublon, setDoublon] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function fusionner() {
    const motif = demanderMotif('fusion de doublons');
    if (!motif) return;
    setErr(null);
    try {
      const r = await api(`/proprietaires/${id}/fusion`, { corps: { doublon_id: doublon.trim(), motif } });
      setMsg(`Fusion effectuée : ${r.droits_rattaches} droit(s) rattaché(s).`);
      recharger();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  if (erreur) return <Erreur message={erreur} />;
  if (!p) return null;
  return (
    <>
      <p className="sous-titre" style={{ marginBottom: 4 }}><Link href="/proprietaires">← Propriétaires</Link></p>
      <h1>{p.nom}</h1>
      <p className="sous-titre">{p.snifi_id} · {libelle(p.type)} · <Badge v={p.statut} classe={p.statut === 'actif' ? 'ok' : 'neutre'} /></p>
      <div className="grille-2">
        <section className="panneau">
          <h2>Fiche</h2>
          <dl className="fiche">
            <dt>Identifiant fiscal</dt><dd>{p.identifiant_fiscal ?? '—'}</dd>
            <dt>Téléphone</dt><dd>{p.telephone ?? '—'}</dd>
            <dt>Courriel</dt><dd>{p.email ?? '—'}</dd>
            <dt>Adresse</dt><dd>{p.adresse ?? '—'}</dd>
            <dt>Source</dt><dd>{p.source_code ?? '—'} ({fmt.date(p.date_source)})</dd>
            <dt>Créé le</dt><dd>{fmt.dateHeure(p.cree_le)}</dd>
          </dl>
        </section>
        <section className="panneau">
          <h2>Fusion de doublon</h2>
          <p className="sous-titre">Rattache à cette fiche les droits, déclarations et transactions d’un doublon (identifiant interne UUID).</p>
          <div className="barre-outils">
            <input placeholder="UUID du doublon" value={doublon} onChange={(e) => setDoublon(e.target.value)} style={{ flex: 1 }} />
            <button onClick={fusionner} disabled={!doublon}>Fusionner</button>
          </div>
          <Erreur message={err} />{msg && <div className="message info">{msg}</div>}
          <small>Identifiant interne de cette fiche : {p.id}</small>
        </section>
      </div>
      <section className="panneau table-scroll">
        <h2>Biens liés</h2>
        <table>
          <thead><tr><th>Parcelle</th><th>Commune / quartier</th><th>Droit</th><th className="num">Quote-part</th><th className="num">Superficie</th><th>Début</th><th>Fin</th></tr></thead>
          <tbody>
            {p.biens.map((b: any) => (
              <tr key={b.droit_id} style={{ opacity: b.date_fin ? 0.55 : 1 }}>
                <td><Link href={`/parcelles/${b.parcelle_id}`}>{b.snifi_id}</Link></td><td>{b.commune_code} · {b.quartier}</td>
                <td>{b.type_droit}</td><td className="num">{(Number(b.quote_part) * 100).toFixed(0)} %</td>
                <td className="num">{fmt.m2(b.superficie_m2)}</td><td>{fmt.date(b.date_debut)}</td><td>{b.date_fin ? fmt.date(b.date_fin) : 'actif'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
