'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Erreur, Pagination, useApi } from '@/components/ui';
import { api, libelle } from '@/lib/api';

const TYPES = ['personne_physique', 'personne_morale', 'copropriete', 'succession', 'etat', 'collectivite', 'autre'];

export default function Proprietaires() {
  const [q, setQ] = useState('');
  const [filtre, setFiltre] = useState('');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState({ type: 'personne_physique', nom: '', identifiant_fiscal: '', telephone: '', adresse: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [erreurForm, setErreurForm] = useState<string | null>(null);
  const { data, erreur, recharger } = useApi(`/proprietaires?page=${page}&taille=25${filtre ? `&q=${encodeURIComponent(filtre)}` : ''}`);

  async function creer(e: FormEvent) {
    e.preventDefault();
    setErreurForm(null);
    try {
      const corps = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ''));
      const p = await api('/proprietaires', { corps });
      setMessage(`Propriétaire créé : ${p.snifi_id}`);
      setForm({ ...form, nom: '', identifiant_fiscal: '', telephone: '', adresse: '' });
      recharger();
    } catch (err: any) {
      setErreurForm(err.message);
    }
  }

  return (
    <>
      <h1>Référentiel des propriétaires</h1>
      <p className="sous-titre">Personnes physiques, morales, copropriétés, successions, État et collectivités.</p>
      <details className="panneau">
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Nouveau propriétaire</summary>
        <form className="formulaire" onSubmit={creer} style={{ marginTop: 12 }}>
          <label>Type<select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {TYPES.map((t) => <option key={t} value={t}>{libelle(t)}</option>)}</select></label>
          <label>Nom / raison sociale<input required value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} /></label>
          <label>Identifiant fiscal<input value={form.identifiant_fiscal} onChange={(e) => setForm({ ...form, identifiant_fiscal: e.target.value })} /></label>
          <label>Téléphone<input value={form.telephone} onChange={(e) => setForm({ ...form, telephone: e.target.value })} /></label>
          <label>Adresse<input value={form.adresse} onChange={(e) => setForm({ ...form, adresse: e.target.value })} /></label>
          <button type="submit">Créer</button>
        </form>
        <div style={{ marginTop: 10 }}><Erreur message={erreurForm} />{message && <div className="message info">{message}</div>}</div>
      </details>
      <form className="barre-outils" onSubmit={(e) => { e.preventDefault(); setPage(1); setFiltre(q); }}>
        <input placeholder="Nom, identifiant SNIFI ou fiscal" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <button type="submit">Rechercher</button>
      </form>
      <Erreur message={erreur} />
      <div className="panneau table-scroll">
        <table>
          <thead><tr><th>Identifiant SNIFI</th><th>Nom / raison sociale</th><th>Type</th><th>Identifiant fiscal</th><th className="num">Biens</th><th>Statut</th></tr></thead>
          <tbody>
            {data?.elements.map((p: any) => (
              <tr key={p.id}>
                <td><Link href={`/proprietaires/${p.id}`}>{p.snifi_id}</Link></td>
                <td>{p.nom}</td><td>{libelle(p.type)}</td><td>{p.identifiant_fiscal ?? '—'}</td>
                <td className="num">{p.nb_biens}</td><td>{p.statut}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <Pagination page={page} taille={25} total={data.total} onPage={setPage} />}
      </div>
    </>
  );
}
