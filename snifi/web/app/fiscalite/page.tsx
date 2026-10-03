'use client';

import { useState } from 'react';
import { demanderMotif, Erreur, useApi } from '@/components/ui';
import { api, fmt } from '@/lib/api';

export default function Fiscalite() {
  const annee = new Date().getFullYear();
  const [exercice, setExercice] = useState(annee);
  const [echeance, setEcheance] = useState(`${annee}-06-30`);
  const { data: synthese, erreur, recharger } = useApi(`/fiscalite/synthese?exercice=${exercice}`);
  const { data: regles } = useApi('/fiscalite/regles');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function executer(fn: () => Promise<string>) {
    setErr(null); setMsg(null);
    try { setMsg(await fn()); recharger(); } catch (e: any) { setErr(e.message); }
  }
  const calculer = () => executer(async () => {
    const r = await api('/fiscalite/calcul', { corps: { exercice } });
    return `${r.impositions_calculees} imposition(s) théorique(s) calculée(s) pour ${exercice}.`;
  });
  const liquider = () => {
    const motif = demanderMotif(`liquidation de l’exercice ${exercice}`);
    if (motif) executer(async () => {
      const r = await api('/fiscalite/liquidation', { corps: { exercice, date_echeance: echeance, motif } });
      return `${r.impositions_liquidees} imposition(s) liquidée(s) — ${fmt.montant(r.montant_total)}.`;
    });
  };

  const total = (k: string) => synthese?.reduce((s: number, x: any) => s + Number(x[k] ?? 0), 0) ?? 0;

  return (
    <>
      <h1>Fiscalité immobilière</h1>
      <p className="sous-titre">Potentiel, liquidation, recouvrement et écart — règles fiscales entièrement paramétrables.</p>
      <section className="panneau">
        <div className="formulaire">
          <label>Exercice<input type="number" value={exercice} onChange={(e) => setExercice(Number(e.target.value))} /></label>
          <button onClick={calculer}>1. Calculer les montants théoriques</button>
          <label>Date d’échéance<input type="date" value={echeance} onChange={(e) => setEcheance(e.target.value)} /></label>
          <button onClick={liquider}>2. Liquider l’exercice</button>
        </div>
        <p className="avertissement">
          Le calcul produit des montants théoriques explicables (base × taux × coefficients). Seule la liquidation par l’administration
          rend un montant exigible ; les impositions liquidées ne sont jamais recalculées.
        </p>
        <Erreur message={err ?? erreur} />{msg && <div className="message info">{msg}</div>}
      </section>
      <section className="panneau table-scroll">
        <h2>Synthèse par commune — {exercice}</h2>
        <table>
          <thead><tr><th>Commune</th><th className="num">Biens imposés</th><th className="num">Potentiel</th><th className="num">Liquidé</th>
            <th className="num">Recouvré</th><th className="num">Écart</th><th className="num">Taux de recouvrement</th></tr></thead>
          <tbody>
            {synthese?.map((s: any) => (
              <tr key={s.commune_code}>
                <td>{s.commune}</td><td className="num">{s.biens_imposes}</td><td className="num">{fmt.montant(s.potentiel)}</td>
                <td className="num">{fmt.montant(s.liquide)}</td><td className="num">{fmt.montant(s.recouvre)}</td>
                <td className="num">{fmt.montant(s.ecart)}</td><td className="num">{s.taux_recouvrement != null ? `${s.taux_recouvrement} %` : '—'}</td>
              </tr>
            ))}
            {synthese?.length > 0 && (
              <tr style={{ fontWeight: 700 }}>
                <td>Total</td><td className="num">{total('biens_imposes')}</td><td className="num">{fmt.montant(total('potentiel'))}</td>
                <td className="num">{fmt.montant(total('liquide'))}</td><td className="num">{fmt.montant(total('recouvre'))}</td>
                <td className="num">{fmt.montant(total('ecart'))}</td><td />
              </tr>
            )}
          </tbody>
        </table>
        {synthese?.length === 0 && <p>Aucune imposition pour cet exercice : lancez le calcul.</p>}
      </section>
      <section className="panneau table-scroll">
        <h2>Règles fiscales paramétrées</h2>
        <table>
          <thead><tr><th>Code</th><th>Libellé</th><th>Impôt</th><th>Assiette</th><th>Usage</th><th className="num">Taux / tarif</th>
            <th className="num">Abattement</th><th>Coef. zone</th><th>Validité</th><th>Référence</th></tr></thead>
          <tbody>
            {regles?.map((r: any) => (
              <tr key={r.id}>
                <td>{r.code}</td><td>{r.libelle}</td><td>{r.impot}</td><td>{r.assiette}</td><td>{r.usage ?? 'tous'}</td>
                <td className="num">{Number(r.taux)}</td><td className="num">{Number(r.abattement)}</td><td>{r.applique_zone ? 'oui' : 'non'}</td>
                <td>{fmt.date(r.date_debut)} → {r.date_fin ? fmt.date(r.date_fin) : '…'}</td><td>{r.reference_legale ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
