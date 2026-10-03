'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { supabase } from '@/lib/api';

export default function Connexion() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@snifi.demo');
  const [mdp, setMdp] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password: mdp });
    setEnvoi(false);
    if (error) return setErreur(error.message === 'Invalid login credentials' ? 'Adresse ou mot de passe incorrect.' : error.message);
    router.replace('/');
  }

  return (
    <div className="connexion">
      <form className="panneau" onSubmit={envoyer}>
        <div className="marque" style={{ padding: 0 }}>SNIFI<small>Système National d’Intelligence Fiscale Immobilière</small></div>
        {erreur && <div className="message erreur">{erreur}</div>}
        <label style={{ display: 'block' }}>Adresse e-mail
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" style={{ width: '100%' }} />
        </label>
        <label style={{ display: 'block' }}>Mot de passe
          <input type="password" value={mdp} onChange={(e) => setMdp(e.target.value)} autoComplete="current-password" style={{ width: '100%' }} />
        </label>
        <button type="submit" disabled={envoi}>{envoi ? 'Connexion…' : 'Se connecter'}</button>
        <p className="avertissement">
          Démonstration : admin, agent, controleur, foncier ou auditeur @snifi.demo (mot de passe : snifi2026).
        </p>
      </form>
    </div>
  );
}
