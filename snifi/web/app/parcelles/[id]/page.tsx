'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Badge, Erreur, useApi } from '@/components/ui';
import { fmt, libelle } from '@/lib/api';

const ONGLETS = ['Synthèse', 'Bâtiments', 'Fiscalité', 'Transactions', 'Anomalies', 'Historique'] as const;

export default function FicheParcelle() {
  const { id } = useParams<{ id: string }>();
  const [onglet, setOnglet] = useState<(typeof ONGLETS)[number]>('Synthèse');
  const { data: p, erreur } = useApi(`/parcelles/${id}`);
  const { data: fisc } = useApi(onglet === 'Fiscalité' ? `/fiscalite/dossier/${id}` : null);
  const { data: histo } = useApi(onglet === 'Historique' ? `/parcelles/${id}/historique` : null);

  if (erreur) return <Erreur message={erreur} />;
  if (!p) return null;
  const actifs = p.droits.filter((d: any) => !d.date_fin);

  return (
    <>
      <p className="sous-titre" style={{ marginBottom: 4 }}><Link href="/parcelles">← Parcelles</Link></p>
      <h1>{p.snifi_id}</h1>
      <p className="sous-titre">{p.commune} · {p.quartier} · <Badge v={p.statut} classe="ok" /></p>

      <div className="barre-outils">
        {ONGLETS.map((o) => (
          <button key={o} className={o === onglet ? '' : 'secondaire'} onClick={() => setOnglet(o)}>
            {o}{o === 'Anomalies' && p.anomalies.filter((a: any) => ['ouverte', 'en_examen'].includes(a.statut)).length
              ? ` (${p.anomalies.filter((a: any) => ['ouverte', 'en_examen'].includes(a.statut)).length})` : ''}
          </button>
        ))}
      </div>

      {onglet === 'Synthèse' && (
        <div className="grille-2">
          <section className="panneau">
            <h2>Identification</h2>
            <dl className="fiche">
              <dt>Référence cadastrale</dt><dd>{p.ref_cadastrale ?? '—'}</dd>
              <dt>Titre foncier</dt><dd>{p.titre_foncier ?? '—'}</dd>
              <dt>Superficie juridique</dt><dd>{fmt.m2(p.superficie_m2)}</dd>
              <dt>Superficie géométrique</dt><dd>{fmt.m2(p.superficie_geom_m2)}</dd>
              <dt>Bâtiments</dt><dd>{p.batiments.length}</dd>
              <dt>Permis</dt><dd>{p.permis.map((x: any) => `${x.numero} (${fmt.date(x.date_delivrance)})`).join(', ') || '—'}</dd>
            </dl>
          </section>
          <section className="panneau">
            <h2>Qualité de la donnée</h2>
            <dl className="fiche">
              <dt>Source</dt><dd>{p.qualite?.source ?? '—'} {p.qualite?.officielle && <Badge v="officielle" classe="ok" />}</dd>
              <dt>Fiabilité</dt><dd>{p.qualite?.fiabilite ? `${p.qualite.fiabilite}/5` : '—'}</dd>
              <dt>Date de la source</dt><dd>{fmt.date(p.qualite?.date)}</dd>
              <dt>Actualité</dt><dd>{p.qualite?.actualite_jours != null ? `${p.qualite.actualite_jours} jours` : '—'}</dd>
              <dt>Dernière modification</dt><dd>{fmt.dateHeure(p.modifie_le)}</dd>
            </dl>
          </section>
          <section className="panneau" style={{ gridColumn: '1 / -1' }}>
            <h2>Droits et titres</h2>
            <table>
              <thead><tr><th>Titulaire</th><th>Type de droit</th><th className="num">Quote-part</th><th>Début</th><th>Fin</th><th>Document</th></tr></thead>
              <tbody>
                {p.droits.map((d: any) => (
                  <tr key={d.id} style={{ opacity: d.date_fin ? 0.55 : 1 }}>
                    <td><Link href={`/proprietaires/${d.proprietaire_id}`}>{d.nom}</Link> <small>{d.proprietaire_snifi_id}</small></td>
                    <td>{d.type_droit}</td>
                    <td className="num">{(Number(d.quote_part) * 100).toFixed(0)} %</td>
                    <td>{fmt.date(d.date_debut)}</td>
                    <td>{d.date_fin ? fmt.date(d.date_fin) : <Badge v="actif" classe="ok" />}</td>
                    <td>{d.document_ref ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {actifs.length === 0 && <p className="message erreur">Aucun titulaire actif.</p>}
          </section>
        </div>
      )}

      {onglet === 'Bâtiments' && (
        <section className="panneau table-scroll">
          <table>
            <thead><tr><th>Identifiant</th><th>Usage</th><th className="num">Surface</th><th className="num">Niveaux</th>
              <th className="num">Logements</th><th className="num">Unités</th><th>Année</th><th className="num">Valeur locative</th><th>Statut fiscal</th><th>Source</th></tr></thead>
            <tbody>
              {p.batiments.map((b: any) => (
                <tr key={b.id}>
                  <td>{b.snifi_id}</td><td>{b.usage}</td><td className="num">{fmt.m2(b.surface_m2)}</td>
                  <td className="num">{b.nb_niveaux}</td><td className="num">{b.nb_logements}</td><td className="num">{b.nb_unites}</td>
                  <td>{b.annee_construction ?? '—'}</td><td className="num">{fmt.montant(b.valeur_locative_totale)}</td>
                  <td><Badge v={b.statut_fiscal} classe="neutre" /></td><td>{b.source_code}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.batiments.length === 0 && <p>Aucun bâtiment enregistré.</p>}
        </section>
      )}

      {onglet === 'Fiscalité' && fisc && (
        <>
          <section className="panneau">
            <h2>Dossier fiscal immobilier</h2>
            <table>
              <thead><tr><th>Exercice</th><th>Propriétaire</th><th className="num">Théorique</th><th className="num">Déclaré</th>
                <th className="num">Liquidé</th><th className="num">Payé</th><th className="num">Solde</th><th>Échéance</th></tr></thead>
              <tbody>
                {fisc.synthese.map((s: any) => (
                  <tr key={`${s.exercice}-${s.proprietaire_id}`}>
                    <td>{s.exercice}</td><td>{s.proprietaire}</td><td className="num">{fmt.montant(s.montant_theorique)}</td>
                    <td className="num">{fmt.montant(s.montant_declare)}</td><td className="num">{fmt.montant(s.montant_liquide)}</td>
                    <td className="num">{fmt.montant(s.montant_paye)}</td><td className="num">{fmt.montant(s.solde)}</td>
                    <td>{fmt.date(s.prochaine_echeance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {fisc.synthese.length === 0 && <p>Aucune imposition calculée. Lancez le calcul depuis l’écran Fiscalité.</p>}
            <p><strong>Arriérés :</strong> {fmt.montant(fisc.arrieres)}</p>
          </section>
          <section className="panneau table-scroll">
            <h2>Détail des impositions (calcul explicable)</h2>
            <table>
              <thead><tr><th>Exercice</th><th>Règle</th><th className="num">Base</th><th>Facteurs</th><th className="num">Montant</th><th>Statut</th></tr></thead>
              <tbody>
                {fisc.impositions.map((i: any) => (
                  <tr key={i.id}>
                    <td>{i.exercice}</td><td>{i.regle_code}<br /><small>{i.regle}</small></td>
                    <td className="num">{fmt.nombre(i.base_imposable)}</td>
                    <td><small>taux {i.detail_calcul.taux} · zone {i.detail_calcul.zone ?? '—'} (×{i.detail_calcul.coefficient_zone})
                      · abattement {i.detail_calcul.abattement} · exonération {i.detail_calcul.exoneration} · quote-part {i.detail_calcul.quote_part}</small></td>
                    <td className="num">{fmt.montant(i.montant_theorique)}</td><td><Badge v={i.statut} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {fisc.declarations.length > 0 && (
            <section className="panneau">
              <h2>Déclarations</h2>
              <table>
                <thead><tr><th>Exercice</th><th className="num">Surface bâtie déclarée</th><th>Usage déclaré</th><th>Dépôt</th></tr></thead>
                <tbody>{fisc.declarations.map((d: any) => (
                  <tr key={d.id}><td>{d.exercice}</td><td className="num">{fmt.m2(d.surface_batie_declaree)}</td><td>{d.usage_declare}</td><td>{fmt.date(d.date_depot)}</td></tr>
                ))}</tbody>
              </table>
            </section>
          )}
        </>
      )}

      {onglet === 'Transactions' && (
        <section className="panneau table-scroll">
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Cédant</th><th>Acquéreur</th><th className="num">Valeur</th><th>Document</th><th>Statut</th></tr></thead>
            <tbody>
              {p.transactions.map((t: any) => (
                <tr key={t.id}><td>{fmt.date(t.date_evenement)}</td><td>{t.type}</td><td>{t.cedant ?? '—'}</td><td>{t.acquereur ?? '—'}</td>
                  <td className="num">{fmt.montant(t.valeur)}</td><td>{t.document_ref}</td><td><Badge v={t.statut} /></td></tr>
              ))}
            </tbody>
          </table>
          {p.transactions.length === 0 && <p>Aucune transaction.</p>}
        </section>
      )}

      {onglet === 'Anomalies' && (
        <section className="panneau table-scroll">
          <p className="avertissement">Une anomalie est un signal objectif nécessitant vérification ; elle ne constitue pas une qualification de fraude.</p>
          <table>
            <thead><tr><th>Règle</th><th>Gravité</th><th>Éléments objectifs</th><th>Statut</th><th>Détectée</th></tr></thead>
            <tbody>
              {p.anomalies.map((a: any) => (
                <tr key={a.id}><td>{a.regle_code} — {a.libelle}</td><td><Badge v={a.gravite} /></td>
                  <td><pre className="json">{JSON.stringify(a.details, null, 1)}</pre></td><td><Badge v={a.statut} classe="neutre" /></td><td>{fmt.date(a.detectee_le)}</td></tr>
              ))}
            </tbody>
          </table>
          {p.anomalies.length === 0 && <p>Aucune anomalie.</p>}
        </section>
      )}

      {onglet === 'Historique' && histo && (
        <section className="panneau table-scroll">
          <h2>Traçabilité : qui, quoi, quand, avant, après, pourquoi, source</h2>
          <table>
            <thead><tr><th>Quand</th><th>Qui</th><th>Quoi</th><th>Avant</th><th>Après</th><th>Pourquoi</th><th>Source</th></tr></thead>
            <tbody>
              {histo.map((h: any) => (
                <tr key={h.id}>
                  <td>{fmt.dateHeure(h.horodatage)}</td><td>{h.utilisateur}</td>
                  <td>{h.action} {h.table_nom}{h.champs ? ` (${h.champs.join(', ')})` : ''}</td>
                  <td><Valeurs v={h.avant} replie={h.action !== 'UPDATE'} /></td>
                  <td><Valeurs v={h.apres} replie={h.action !== 'UPDATE'} /></td>
                  <td>{h.motif ?? '—'}</td><td>{libelle(h.source)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function Valeurs({ v, replie }: { v: Record<string, unknown> | null; replie: boolean }) {
  if (!v) return <>—</>;
  const pre = <pre className="json">{JSON.stringify(sansGeom(v), null, 1)}</pre>;
  return replie ? <details><summary style={{ cursor: 'pointer' }}>Enregistrement complet</summary>{pre}</details> : pre;
}

function sansGeom(o: Record<string, unknown>) {
  const { geom, ...reste } = o;
  return geom ? { ...reste, geom: '[géométrie]' } : reste;
}
