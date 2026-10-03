'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, ouvrirSession } from '@/lib/api';

export default function Connexion() {
  const router = useRouter();
  const [login, setLogin] = useState('admin');
  const [mdp, setMdp] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    setErreur(null);
    try {
      const r = await api('/auth/connexion', { corps: { login, mot_de_passe: mdp } });
      ouvrirSession(r.jeton, r.utilisateur);
      router.replace('/');
    } catch (err: any) {
      setErreur(err.message);
    }
  }

  return (
    <div className="connexion">
      <form className="panneau" onSubmit={envoyer}>
        <div className="marque" style={{ padding: 0 }}>SNIFI<small>Système National d’Intelligence Fiscale Immobilière</small></div>
        {erreur && <div className="message erreur">{erreur}</div>}
        <label className="formulaire" style={{ display: 'block' }}>Identifiant
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block' }}>Mot de passe
          <input type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="current-password" style={{ width: '100%' }} />
        </label>
        <button type="submit">Se connecter</button>
        <p className="avertissement">
          Prototype — comptes de démonstration : admin, agent, controleur, foncier, auditeur (mot de passe : snifi2026).
        </p>
      </form>
    </div>
  );
}
