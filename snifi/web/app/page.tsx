'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Erreur, useRpc } from '@/components/ui';
import { fmt } from '@/lib/api';

export default function TableauDeBord() {
  const [exercice, setExercice] = useState(new Date().getFullYear());
  const { data, erreur } = useRpc('tableau_de_bord', { p_exercice: exercice });
  const i = data?.indicateurs;
  const recouvrement = i && Number(i.liquide) > 0 ? (100 * Number(i.recouvre)) / Number(i.liquide) : null;

  return (
    <>
      <h1>Tableau de bord national</h1>
      <p className="sous-titre">Connaissance du patrimoine immobilier et de l’assiette fiscale · exercice{' '}
        <select value={exercice} onChange={(e) => setExercice(Number(e.target.value))}>
          {[0, 1, 2].map((d) => <option key={d}>{new Date().getFullYear() - d}</option>)}
        </select>
      </p>
      <Erreur message={erreur} />
      {i && (
        <>
          <div className="carte-kpi">
            <Kpi lib="Parcelles" val={fmt.nombre(i.parcelles)} />
            <Kpi lib="Bâtiments" val={fmt.nombre(i.batiments)} />
            <Kpi lib="Unités" val={fmt.nombre(i.unites)} />
            <Kpi lib="Propriétaires" val={fmt.nombre(i.proprietaires)} />
            <Kpi lib="Biens imposés" val={fmt.nombre(i.biens_imposables)} />
            <Kpi lib="Anomalies ouvertes" val={fmt.nombre(i.anomalies_ouvertes)} />
          </div>
          <div className="carte-kpi">
            <Kpi lib="Potentiel théorique" val={fmt.montant(i.potentiel)} />
            <Kpi lib="Liquidé" val={fmt.montant(i.liquide)} />
            <Kpi lib="Recouvré" val={fmt.montant(i.recouvre)} />
            <Kpi lib="Taux de recouvrement" val={recouvrement === null ? '—' : `${recouvrement.toFixed(1)} %`} />
            <Kpi lib="Écart potentiel / recouvré" val={fmt.montant(Number(i.potentiel) - Number(i.recouvre))} />
            <Kpi lib="Arriérés" val={fmt.montant(i.arrieres)} />
          </div>
          <p className="avertissement">
            Le potentiel théorique est une estimation issue des règles paramétrées : il est distinct des montants juridiquement exigibles (liquidés).
          </p>
          <div className="grille-2">
            <section className="panneau">
              <h2>Anomalies ouvertes par règle</h2>
              <table>
                <thead><tr><th>Règle</th><th>Gravité</th><th className="num">Ouvertes</th></tr></thead>
                <tbody>
                  {data.anomalies.map((a: any) => (
                    <tr key={a.code}>
                      <td><Link href={`/anomalies?regle=${a.code}`}>{a.code} — {a.libelle}</Link></td>
                      <td><Badge v={a.gravite} /></td>
                      <td className="num">{a.ouvertes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="panneau">
              <h2>Analyse territoriale</h2>
              <table>
                <thead><tr><th>Commune</th><th className="num">Parcelles</th><th className="num">Bâties</th><th className="num">Anomalies</th></tr></thead>
                <tbody>
                  {data.communes.map((c: any) => (
                    <tr key={c.commune_code}>
                      <td><Link href={`/parcelles?commune=${c.commune_code}`}>{c.nom}</Link></td>
                      <td className="num">{c.parcelles}</td>
                      <td className="num">{c.parcelles_baties}</td>
                      <td className="num">{c.anomalies}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h2 style={{ marginTop: 20 }}>Bâtiments par usage</h2>
              <table>
                <thead><tr><th>Usage</th><th className="num">Bâtiments</th><th className="num">Surface</th></tr></thead>
                <tbody>
                  {data.usages.map((u: any) => (
                    <tr key={u.usage}><td>{u.usage}</td><td className="num">{u.batiments}</td><td className="num">{fmt.m2(u.surface_m2)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </>
  );
}

function Kpi({ lib, val }: { lib: string; val: string }) {
  return <div className="kpi"><div className="lib">{lib}</div><div className="val">{val}</div></div>;
}
