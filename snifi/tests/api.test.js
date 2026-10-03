/**
 * Tests de bout en bout de l'API SNIFI (fonctions RPC Supabase) sur PostgreSQL + PostGIS.
 *
 * La base de test (PGDATABASE_TEST, par défaut snifi_test) est SUPPRIMÉE puis recréée.
 * Supabase Auth est simulé par auth_stub.sql ; chaque appel s'exécute sous le rôle
 * « authenticated » avec l'identifiant de l'utilisateur, comme le fait PostgREST.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ICI = dirname(fileURLToPath(import.meta.url));
const SUPABASE = join(ICI, '..', 'supabase');
const SERVEUR = process.env.PG_URL ?? 'postgres://snifi:snifi@localhost:5432';
const BASE = process.env.PGDATABASE_TEST ?? 'snifi_test';

let pool;
const uids = {};

async function preparerBase() {
  const admin = new pg.Client({ connectionString: `${SERVEUR}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${BASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${BASE}`);
  await admin.end();
  const c = new pg.Client({ connectionString: `${SERVEUR}/${BASE}` });
  await c.connect();
  try {
    await c.query(readFileSync(join(ICI, 'auth_stub.sql'), 'utf8'));
    for (const f of readdirSync(join(SUPABASE, 'migrations')).sort()) {
      await c.query(readFileSync(join(SUPABASE, 'migrations', f), 'utf8'));
    }
    await c.query(readFileSync(join(SUPABASE, 'seed.sql'), 'utf8'));
  } finally {
    await c.end();
  }
}

/** Appelle une fonction de l'API comme le ferait supabase.rpc(fn, args) avec la session de `login`. */
async function rpc(login, fn, args = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (login) await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uids[login]]);
    await c.query('SET LOCAL ROLE authenticated');
    const noms = Object.keys(args);
    const valeurs = noms.map((k) => (args[k] !== null && typeof args[k] === 'object' && !Array.isArray(args[k]) ? JSON.stringify(args[k]) : args[k]));
    const r = await c.query(`SELECT public.${fn}(${noms.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, valeurs);
    await c.query('COMMIT');
    return r.rows[0].r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
const echoue = (promesse, motif) => assert.rejects(promesse, (e) => (motif instanceof RegExp ? motif.test(e.message) : e.code === motif));
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

before(async () => {
  await preparerBase();
  pool = new pg.Pool({ connectionString: `${SERVEUR}/${BASE}` });
  for (const r of (await pool.query('SELECT p.login, p.user_id FROM snifi.profils p')).rows) uids[r.login] = r.user_id;
});
after(async () => { await pool?.end(); });

describe('Sécurité', () => {
  it('refuse un appel sans session', () => echoue(rpc(null, 'parcelles_lister'), 'SN401'));

  it('refuse un appel du rôle anonyme (droits d’exécution)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN; SET LOCAL ROLE anon');
      await assert.rejects(c.query('SELECT public.parcelles_lister()'), /permission denied/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('les tables ne sont pas accessibles directement', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN; SET LOCAL ROLE authenticated');
      await assert.rejects(c.query('SELECT * FROM snifi.parcelles'), /permission denied/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });

  it('applique le RBAC : un agent fiscal ne peut pas créer de parcelle', () =>
    echoue(rpc('agent', 'parcelle_creer', { p_data: { commune_code: 'CI-ABJ-COC' } }), 'SN403'));

  it("restreint l'agent à son territoire", async () => {
    const r = await rpc('agent', 'parcelles_lister', { p_taille: 500 });
    assert.equal(r.total, 24);
    assert.ok(r.elements.every((p) => p.commune_code === 'CI-ABJ-COC'));
    assert.equal((await rpc('admin', 'parcelles_lister', { p_taille: 500 })).total, 36);
  });

  it("réserve le journal d'audit aux auditeurs et administrateurs", async () => {
    await echoue(rpc('agent', 'audit_journal'), 'SN403');
    assert.ok(Array.isArray(await rpc('auditeur', 'audit_journal')));
  });

  it('renvoie le profil de la session', async () => {
    const m = await rpc('agent', 'moi');
    assert.equal(m.role, 'agent_fiscal');
    assert.equal(m.territoire_code, 'CI-ABJ-COC');
  });
});

describe('Référentiel', () => {
  let proprietaire, parcelle;

  it('crée un propriétaire avec un identifiant SNIFI', async () => {
    const p = await rpc('foncier', 'proprietaire_creer', { p_data: { type: 'personne_physique', nom: 'TEST Awa', identifiant_fiscal: 'NCC-TEST-1' } });
    assert.match(p.snifi_id, /^PROP-\d{9}$/);
    proprietaire = p.id;
  });

  it('rejette des données invalides', () =>
    echoue(rpc('foncier', 'proprietaire_creer', { p_data: { type: 'inconnu', nom: 'XY' } }), '23514'));

  it('crée une parcelle géolocalisée avec identifiant immobilier SNIFI', async () => {
    const p = await rpc('foncier', 'parcelle_creer', { p_data: {
      commune_code: 'CI-ABJ-COC', quartier: 'Test', superficie_m2: 800, proprietaire_id: proprietaire,
      geometrie: { type: 'Polygon', coordinates: [[[-3.975, 5.35], [-3.97474, 5.35], [-3.97474, 5.35026], [-3.975, 5.35026], [-3.975, 5.35]]] },
    } });
    assert.match(p.snifi_id, /^SNIFI-CI-ABJ-COC-\d{8}$/);
    assert.ok(Number(p.superficie_geom_m2) > 700);
    parcelle = p.id;
  });

  it('exige un motif pour toute modification', async () => {
    await echoue(rpc('foncier', 'parcelle_modifier', { p_id: parcelle, p_data: { superficie_m2: 820 }, p_motif: null }), 'SN001');
    const r = await rpc('foncier', 'parcelle_modifier', { p_id: parcelle, p_data: { superficie_m2: 820 }, p_motif: 'Document justificatif : nouveau bornage' });
    assert.equal(Number(r.superficie_m2), 820);
  });

  it('la base refuse une modification sans motif, même hors API', async () => {
    await assert.rejects(pool.query("UPDATE snifi.parcelles SET quartier = 'x' WHERE id = $1", [parcelle]), (e) => e.code === 'SN001');
  });

  it("trace QUI / QUOI / QUAND / AVANT / APRÈS / POURQUOI dans l'historique", async () => {
    const h = await rpc('agent', 'parcelle_historique', { p_id: parcelle });
    const maj = h.find((e) => e.action === 'UPDATE' && e.table_nom === 'parcelles');
    assert.equal(maj.utilisateur, 'foncier (service_foncier)');
    assert.deepEqual(maj.champs, ['superficie_m2']);
    assert.equal(maj.avant.superficie_m2, 800);
    assert.equal(maj.apres.superficie_m2, 820);
    assert.equal(maj.motif, 'Document justificatif : nouveau bornage');
    assert.ok(h.some((e) => e.table_nom === 'droits' && e.action === 'INSERT'));
  });

  it('rattache bâtiment et unités à la parcelle', async () => {
    const b = await rpc('foncier', 'batiment_creer', { p_data: { parcelle_id: parcelle, usage: 'habitation', surface_m2: 200, statut_fiscal: 'imposable' } });
    assert.match(b.snifi_id, /-B001$/);
    await rpc('foncier', 'unite_ajouter', { p_batiment: b.id, p_data: { numero: 'A1', valeur_locative: 1000000 } });
    const d = await rpc('agent', 'parcelle_detail', { p_id: parcelle });
    assert.equal(d.batiments.length, 1);
    assert.equal(d.droits[0].nom, 'TEST Awa');
    assert.equal(d.geometrie.type, 'MultiPolygon');
  });

  it('applique une mutation : clôture le droit du cédant et ouvre celui de l’acquéreur', async () => {
    const acq = await rpc('foncier', 'proprietaire_creer', { p_data: { type: 'personne_morale', nom: 'SCI TEST' } });
    const t = await rpc('foncier', 'transaction_creer', { p_data: {
      type: 'vente', parcelle_id: parcelle, date_evenement: new Date().toISOString().slice(0, 10), valeur: 120000000,
      cedant_id: proprietaire, acquereur_id: acq.id } });
    await echoue(rpc('foncier', 'transaction_appliquer', { p_id: t.id, p_motif: '' }), 'SN001');
    const antidatee = await rpc('foncier', 'transaction_creer', { p_data: {
      type: 'vente', parcelle_id: parcelle, date_evenement: '2020-01-01', cedant_id: proprietaire, acquereur_id: acq.id } });
    await echoue(rpc('foncier', 'transaction_appliquer', { p_id: antidatee.id, p_motif: 'Acte notarié enregistré' }), /antérieure/);
    const r = await rpc('foncier', 'transaction_appliquer', { p_id: t.id, p_motif: 'Acte notarié enregistré' });
    assert.equal(r.droits_crees, 1);
    const d = await rpc('agent', 'parcelle_detail', { p_id: parcelle });
    const actifs = d.droits.filter((x) => !x.date_fin);
    assert.equal(actifs.length, 1);
    assert.equal(actifs[0].nom, 'SCI TEST');
  });

  it('cartographie : renvoie un FeatureCollection GeoJSON filtré par emprise', async () => {
    const fc = await rpc('admin', 'carto_parcelles', { p_bbox: [-3.99, 5.34, -3.97, 5.36] });
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 25);
    assert.ok(fc.features[0].properties.snifi_id);
  });
});

describe('Fiscalité', () => {
  it('calcule les impositions théoriques de manière explicable', async () => {
    const r = await rpc('agent', 'fiscalite_calculer', { p_exercice: 2026 });
    assert.ok(r.impositions_calculees > 20);
    const imp = await one(
      `SELECT i.*, u.vl FROM snifi.impositions i JOIN snifi.regles_fiscales r ON r.id = i.regle_id
         JOIN LATERAL (SELECT sum(valeur_locative) AS vl FROM snifi.unites un JOIN snifi.batiments b ON b.id = un.batiment_id
                       WHERE b.parcelle_id = i.parcelle_id AND b.usage = 'habitation') u ON true
        WHERE r.code = 'IFB-HAB' AND i.exercice = 2026 LIMIT 1`);
    const d = imp.detail_calcul;
    assert.equal(Number(imp.base_imposable), Number(imp.vl));
    assert.equal(Number(imp.montant_theorique), Math.round(d.base * (1 - d.abattement) * d.taux * d.coefficient_zone * (1 - d.exoneration) * d.quote_part));
    assert.match(d.formule, /coefficient_zone/);
  });

  it('liquide, encaisse et met à jour le dossier fiscal', async () => {
    await echoue(rpc('agent', 'fiscalite_liquider', { p_exercice: 2026, p_echeance: '2026-06-30', p_motif: null }), 'SN001');
    const l = await rpc('admin', 'fiscalite_liquider', { p_exercice: 2026, p_echeance: '2026-06-30', p_motif: 'Émission des avis 2026' });
    assert.ok(l.impositions_liquidees > 0);
    const imp = await one("SELECT id, parcelle_id, montant_liquide FROM snifi.impositions WHERE statut = 'liquidee' ORDER BY montant_liquide DESC LIMIT 1");
    await rpc('admin', 'paiement_enregistrer', { p_data: { imposition_id: imp.id, montant: Number(imp.montant_liquide), date_paiement: '2026-05-10', reference: 'QUITTANCE-TEST-1' } });
    const dossier = await rpc('admin', 'dossier_fiscal', { p_parcelle: imp.parcelle_id, p_exercice: 2026 });
    const ligne = dossier.impositions.find((i) => i.id === imp.id);
    assert.equal(ligne.statut, 'soldee');
    assert.equal(Number(ligne.montant_paye), Number(imp.montant_liquide));
    const s = await rpc('admin', 'fiscalite_synthese', { p_exercice: 2026 });
    assert.equal(s.length, 2);
    assert.ok(Number(s.find((x) => x.commune_code === 'CI-ABJ-COC').recouvre) > 0);
  });

  it("l'agent ne liquide que son territoire", async () => {
    const c = await pool.connect();
    try {
      await c.query("SELECT set_config('snifi.motif', 'Préparation du test', false)");
      await c.query("UPDATE snifi.impositions SET statut = 'calculee', montant_liquide = NULL WHERE statut = 'liquidee'");
    } finally { c.release(); }
    const r = await rpc('agent', 'fiscalite_liquider', { p_exercice: 2026, p_echeance: '2026-06-30', p_motif: 'Émission Cocody' });
    const yop = await one(`SELECT count(*)::int AS n FROM snifi.impositions i JOIN snifi.parcelles p ON p.id = i.parcelle_id
                            WHERE p.commune_code = 'CI-ABJ-YOP' AND i.statut = 'liquidee'`);
    assert.ok(r.impositions_liquidees > 0);
    assert.equal(yop.n, 0);
  });

  it('ne recalcule pas une imposition liquidée', async () => {
    const avant = await one("SELECT count(*)::int AS n FROM snifi.impositions WHERE statut <> 'calculee'");
    await rpc('agent', 'fiscalite_calculer', { p_exercice: 2026 });
    const apres = await one("SELECT count(*)::int AS n FROM snifi.impositions WHERE statut <> 'calculee'");
    assert.equal(apres.n, avant.n);
  });
});

describe("Moteur d'anomalies", () => {
  it('détecte les six familles d’anomalies du jeu de démonstration', async () => {
    const r = await rpc('controleur', 'anomalies_executer');
    const par = Object.fromEntries(r.resultats.map((x) => [x.regle, x]));
    for (const code of ['A001', 'A002', 'A003', 'A004', 'A005', 'A006']) assert.ok(par[code].detectees > 0, code);
    assert.equal(par.A003.detectees, 1);
  });

  it('est idempotent : une seconde exécution ne crée pas de doublon', async () => {
    const r = await rpc('controleur', 'anomalies_executer');
    assert.ok(r.resultats.every((x) => x.nouvelles === 0));
  });

  it('passe en « corrigée » une anomalie dont la cause a disparu', async () => {
    const a = await one("SELECT details FROM snifi.anomalies WHERE regle_code = 'A003' AND statut = 'ouverte'");
    const t = await rpc('foncier', 'transaction_appliquer', { p_id: a.details.transaction_id, p_motif: 'Mise à jour suite anomalie A003' });
    assert.equal(t.statut, 'appliquee');
    const r = await rpc('controleur', 'anomalies_executer', { p_regles: ['A003'] });
    assert.equal(r.resultats[0].detectees, 0);
    assert.equal(r.resultats[0].corrigees, 1);
  });

  it('impose le cycle de traitement et un motif', async () => {
    const a = await one("SELECT id FROM snifi.anomalies WHERE statut = 'ouverte' LIMIT 1");
    await echoue(rpc('controleur', 'anomalie_traiter', { p_id: a.id, p_statut: 'confirmee', p_motif: 'Vérifié sur place' }), /Transition non autorisée/);
    await echoue(rpc('controleur', 'anomalie_traiter', { p_id: a.id, p_statut: 'en_examen', p_motif: null }), 'SN001');
    const r = await rpc('controleur', 'anomalie_traiter', { p_id: a.id, p_statut: 'en_examen', p_motif: 'Dossier transmis pour vérification' });
    assert.equal(r.traitee_par, 'controleur');
  });

  it('les paramètres des règles sont modifiables sans code', async () => {
    const r = await rpc('admin', 'anomalie_regle_modifier', { p_code: 'A002', p_parametres: { ecart_relatif_max: 0.5 }, p_motif: 'Ajustement du seuil après calibrage' });
    assert.equal(r.parametres.ecart_relatif_max, 0.5);
    const e = await rpc('controleur', 'anomalies_executer', { p_regles: ['A002'] });
    assert.equal(e.resultats[0].detectees, 0);
  });
});

describe('Tableau de bord et audit', () => {
  it('produit les indicateurs nationaux', async () => {
    const r = await rpc('admin', 'tableau_de_bord', { p_exercice: 2026 });
    assert.equal(r.indicateurs.parcelles, 37);
    assert.ok(Number(r.indicateurs.potentiel) > 0);
    assert.equal(r.anomalies.length, 6);
  });

  it("le journal d'audit est intègre et immuable", async () => {
    const v = await rpc('auditeur', 'audit_verifier');
    assert.equal(v.integre, true);
    await assert.rejects(pool.query('DELETE FROM snifi.journal_audit WHERE id = 1'), (e) => e.code === 'SN002');
    await assert.rejects(pool.query("UPDATE snifi.journal_audit SET motif = 'x' WHERE id = 1"), (e) => e.code === 'SN002');
  });

  it('détecte une altération du journal', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE snifi.journal_audit DISABLE TRIGGER journal_audit_no_update');
      await c.query(`UPDATE snifi.journal_audit SET apres = '{"superficie_m2": 1}' WHERE id = 3`);
      const r = await c.query('SELECT * FROM snifi.verifier_journal()');
      assert.equal(r.rows[0].id, '3');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
