/**
 * Tests de bout en bout de l'API SNIFI sur une base PostgreSQL/PostGIS réelle.
 * La base désignée par DATABASE_URL (par défaut snifi_test) est REMISE À ZÉRO.
 */
process.env.DATABASE_URL ??= 'postgres://snifi:snifi@localhost:5432/snifi_test';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { migrate } from '../scripts/migrate';
import { creerApplication } from '../src/main';
import { DbService } from '../src/db/db.service';

let app: INestApplication;
let db: DbService;
const jetons: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const as = (login: string) => ({ Authorization: `Bearer ${jetons[login]}` });

beforeAll(async () => {
  await migrate({ reset: true, seed: true, log: false });
  app = await creerApplication();
  await app.init();
  db = app.get(DbService);
  for (const login of ['admin', 'agent', 'controleur', 'foncier', 'auditeur']) {
    const r = await api().post('/api/v1/auth/connexion').send({ login, mot_de_passe: 'snifi2026' }).expect(201);
    jetons[login] = r.body.jeton;
  }
});

afterAll(async () => {
  await app?.close();
});

describe('Sécurité', () => {
  it('refuse les requêtes non authentifiées', async () => {
    await api().get('/api/v1/parcelles').expect(401);
  });

  it('refuse des identifiants invalides', async () => {
    await api().post('/api/v1/auth/connexion').send({ login: 'admin', mot_de_passe: 'x' }).expect(401);
  });

  it("applique le RBAC : un agent fiscal ne peut pas créer de parcelle", async () => {
    await api().post('/api/v1/parcelles').set(as('agent')).send({ commune_code: 'CI-ABJ-COC' }).expect(403);
  });

  it("restreint l'agent à son territoire", async () => {
    const r = await api().get('/api/v1/parcelles?taille=500').set(as('agent')).expect(200);
    expect(r.body.total).toBe(24);
    expect(r.body.elements.every((p: any) => p.commune_code === 'CI-ABJ-COC')).toBe(true);
    const admin = await api().get('/api/v1/parcelles?taille=500').set(as('admin')).expect(200);
    expect(admin.body.total).toBe(36);
  });

  it("réserve le journal d'audit aux auditeurs et administrateurs", async () => {
    await api().get('/api/v1/audit').set(as('agent')).expect(403);
    await api().get('/api/v1/audit').set(as('auditeur')).expect(200);
  });
});

describe('Référentiel', () => {
  let proprietaireId: string;
  let parcelleId: string;

  it('crée un propriétaire avec un identifiant SNIFI', async () => {
    const r = await api().post('/api/v1/proprietaires').set(as('foncier'))
      .send({ type: 'personne_physique', nom: 'TEST Awa', identifiant_fiscal: 'NCC-TEST-1' }).expect(201);
    expect(r.body.snifi_id).toMatch(/^PROP-\d{9}$/);
    proprietaireId = r.body.id;
  });

  it('rejette des données invalides', async () => {
    const r = await api().post('/api/v1/proprietaires').set(as('foncier')).send({ type: 'inconnu', nom: 'X' }).expect(400);
    expect(r.body.erreurs.length).toBeGreaterThan(0);
  });

  it('crée une parcelle géolocalisée avec identifiant immobilier SNIFI', async () => {
    const r = await api().post('/api/v1/parcelles').set(as('foncier')).send({
      commune_code: 'CI-ABJ-COC', quartier: 'Test', superficie_m2: 800, proprietaire_id: proprietaireId,
      geometrie: { type: 'Polygon', coordinates: [[[-3.975, 5.35], [-3.97474, 5.35], [-3.97474, 5.35026], [-3.975, 5.35026], [-3.975, 5.35]]] },
    }).expect(201);
    expect(r.body.snifi_id).toMatch(/^SNIFI-CI-ABJ-COC-\d{8}$/);
    expect(Number(r.body.superficie_geom_m2)).toBeGreaterThan(700);
    parcelleId = r.body.id;
  });

  it('exige un motif pour toute modification', async () => {
    await api().patch(`/api/v1/parcelles/${parcelleId}`).set(as('foncier')).send({ superficie_m2: 820 }).expect(400);
    await api().patch(`/api/v1/parcelles/${parcelleId}`).set(as('foncier'))
      .send({ superficie_m2: 820, motif: 'Document justificatif : nouveau bornage' }).expect(200);
  });

  it("trace QUI / QUOI / QUAND / AVANT / APRÈS / POURQUOI dans l'historique", async () => {
    const r = await api().get(`/api/v1/parcelles/${parcelleId}/historique`).set(as('agent')).expect(200);
    const maj = r.body.find((e: any) => e.action === 'UPDATE' && e.table_nom === 'parcelles');
    expect(maj).toMatchObject({
      utilisateur: 'foncier (service_foncier)',
      champs: ['superficie_m2'],
      avant: { superficie_m2: 800 },
      apres: { superficie_m2: 820 },
      motif: 'Document justificatif : nouveau bornage',
    });
    expect(r.body.some((e: any) => e.table_nom === 'droits' && e.action === 'INSERT')).toBe(true);
  });

  it('rattache bâtiment et unités à la parcelle', async () => {
    const b = await api().post('/api/v1/batiments').set(as('foncier'))
      .send({ parcelle_id: parcelleId, usage: 'habitation', surface_m2: 200, statut_fiscal: 'imposable' }).expect(201);
    expect(b.body.snifi_id).toMatch(/-B001$/);
    await api().post(`/api/v1/batiments/${b.body.id}/unites`).set(as('foncier'))
      .send({ numero: 'A1', valeur_locative: 1_000_000 }).expect(201);
    const d = await api().get(`/api/v1/parcelles/${parcelleId}`).set(as('agent')).expect(200);
    expect(d.body.batiments).toHaveLength(1);
    expect(d.body.droits[0].nom).toBe('TEST Awa');
    expect(d.body.geometrie.type).toBe('MultiPolygon');
  });

  it('applique une mutation : clôture le droit du cédant et ouvre celui de l’acquéreur', async () => {
    const acq = await api().post('/api/v1/proprietaires').set(as('foncier'))
      .send({ type: 'personne_morale', nom: 'SCI TEST' }).expect(201);
    const t = await api().post('/api/v1/transactions').set(as('foncier')).send({
      type: 'vente', parcelle_id: parcelleId, date_evenement: new Date().toISOString().slice(0, 10), valeur: 120_000_000,
      cedant_id: proprietaireId, acquereur_id: acq.body.id,
    }).expect(201);
    await api().post(`/api/v1/transactions/${t.body.id}/appliquer`).set(as('foncier')).send({}).expect(400);
    const antidatee = await api().post('/api/v1/transactions').set(as('foncier')).send({
      type: 'vente', parcelle_id: parcelleId, date_evenement: '2020-01-01', cedant_id: proprietaireId, acquereur_id: acq.body.id,
    }).expect(201);
    const refus = await api().post(`/api/v1/transactions/${antidatee.body.id}/appliquer`).set(as('foncier'))
      .send({ motif: 'Acte notarié enregistré' }).expect(400);
    expect(refus.body.message).toContain('antérieure');
    const r = await api().post(`/api/v1/transactions/${t.body.id}/appliquer`).set(as('foncier'))
      .send({ motif: 'Acte notarié enregistré' }).expect(201);
    expect(r.body.droits_crees).toBe(1);
    const d = await api().get(`/api/v1/parcelles/${parcelleId}`).set(as('agent')).expect(200);
    const actifs = d.body.droits.filter((x: any) => !x.date_fin);
    expect(actifs).toHaveLength(1);
    expect(actifs[0].nom).toBe('SCI TEST');
  });

  it('cartographie : renvoie un FeatureCollection GeoJSON filtré par emprise', async () => {
    const r = await api().get('/api/v1/cartographie/parcelles?bbox=-3.99,5.34,-3.97,5.36').set(as('admin')).expect(200);
    expect(r.body.type).toBe('FeatureCollection');
    expect(r.body.features.length).toBe(25);
    expect(r.body.features[0].properties.snifi_id).toBeDefined();
  });
});

describe('Fiscalité', () => {
  it('calcule les impositions théoriques de manière explicable', async () => {
    const r = await api().post('/api/v1/fiscalite/calcul').set(as('agent')).send({ exercice: 2026 }).expect(201);
    expect(r.body.impositions_calculees).toBeGreaterThan(20);
    const imp = await db.one(
      `SELECT i.*, u.vl FROM snifi.impositions i JOIN snifi.regles_fiscales r ON r.id = i.regle_id
         JOIN LATERAL (SELECT sum(valeur_locative) AS vl FROM snifi.unites un JOIN snifi.batiments b ON b.id = un.batiment_id
                       WHERE b.parcelle_id = i.parcelle_id AND b.usage = 'habitation') u ON true
        WHERE r.code = 'IFB-HAB' AND i.exercice = 2026 LIMIT 1`);
    const d = imp.detail_calcul;
    expect(Number(imp.base_imposable)).toBe(Number(imp.vl));
    expect(Number(imp.montant_theorique)).toBe(Math.round(d.base * (1 - d.abattement) * d.taux * d.coefficient_zone * (1 - d.exoneration) * d.quote_part));
    expect(d.formule).toContain('coefficient_zone');
  });

  it('liquide, encaisse et met à jour le dossier fiscal', async () => {
    await api().post('/api/v1/fiscalite/liquidation').set(as('agent')).send({ exercice: 2026, date_echeance: '2026-06-30' }).expect(400);
    const l = await api().post('/api/v1/fiscalite/liquidation').set(as('agent'))
      .send({ exercice: 2026, date_echeance: '2026-06-30', motif: 'Émission des avis 2026' }).expect(201);
    expect(l.body.impositions_liquidees).toBeGreaterThan(0);

    const imp = await db.one("SELECT id, parcelle_id, montant_liquide FROM snifi.impositions WHERE statut = 'liquidee' ORDER BY montant_liquide DESC LIMIT 1");
    await api().post('/api/v1/fiscalite/paiements').set(as('agent')).send({
      imposition_id: imp.id, montant: Number(imp.montant_liquide), date_paiement: '2026-05-10', reference: 'QUITTANCE-TEST-1',
    }).expect(201);
    const dossier = await api().get(`/api/v1/fiscalite/dossier/${imp.parcelle_id}?exercice=2026`).set(as('agent')).expect(200);
    const ligne = dossier.body.impositions.find((i: any) => i.id === imp.id);
    expect(ligne.statut).toBe('soldee');
    expect(Number(ligne.montant_paye)).toBe(Number(imp.montant_liquide));

    const s = await api().get('/api/v1/fiscalite/synthese?exercice=2026').set(as('admin')).expect(200);
    expect(s.body.length).toBe(2);
    expect(Number(s.body.find((x: any) => x.commune_code === 'CI-ABJ-COC').recouvre)).toBeGreaterThan(0);
  });

  it('ne recalcule pas une imposition liquidée', async () => {
    const avant = await db.one("SELECT count(*)::int AS n FROM snifi.impositions WHERE statut <> 'calculee'");
    await api().post('/api/v1/fiscalite/calcul').set(as('agent')).send({ exercice: 2026 }).expect(201);
    const apres = await db.one("SELECT count(*)::int AS n FROM snifi.impositions WHERE statut <> 'calculee'");
    expect(apres.n).toBe(avant.n);
  });
});

describe("Moteur d'anomalies", () => {
  it('détecte les six familles d’anomalies du jeu de démonstration', async () => {
    const r = await api().post('/api/v1/anomalies/executer').set(as('controleur')).send({}).expect(201);
    const parRegle = Object.fromEntries(r.body.resultats.map((x: any) => [x.regle, x]));
    for (const code of ['A001', 'A002', 'A003', 'A004', 'A005', 'A006']) {
      expect(parRegle[code].detectees).toBeGreaterThan(0);
    }
    // A003 : la vente n°9 n'a pas été répercutée
    expect(parRegle.A003.detectees).toBe(1);
  });

  it("est idempotent : une seconde exécution ne crée pas de doublon", async () => {
    const r = await api().post('/api/v1/anomalies/executer').set(as('controleur')).send({}).expect(201);
    expect(r.body.resultats.every((x: any) => x.nouvelles === 0)).toBe(true);
  });

  it("passe en « corrigée » une anomalie dont la cause a disparu", async () => {
    const a = await db.one("SELECT a.id, a.details FROM snifi.anomalies a WHERE regle_code = 'A003' AND statut = 'ouverte'");
    const t = await api().post(`/api/v1/transactions/${a.details.transaction_id}/appliquer`).set(as('foncier'))
      .send({ motif: 'Mise à jour suite anomalie A003' }).expect(201);
    expect(t.body.statut).toBe('appliquee');
    const r = await api().post('/api/v1/anomalies/executer').set(as('controleur')).send({ regles: ['A003'] }).expect(201);
    expect(r.body.resultats[0]).toMatchObject({ detectees: 0, corrigees: 1 });
  });

  it('impose le cycle de traitement et un motif', async () => {
    const a = await db.one("SELECT id FROM snifi.anomalies WHERE statut = 'ouverte' LIMIT 1");
    await api().patch(`/api/v1/anomalies/${a.id}`).set(as('controleur')).send({ statut: 'confirmee', motif: 'Vérifié sur place' }).expect(400);
    await api().patch(`/api/v1/anomalies/${a.id}`).set(as('controleur')).send({ statut: 'en_examen' }).expect(400);
    const r = await api().patch(`/api/v1/anomalies/${a.id}`).set(as('controleur'))
      .send({ statut: 'en_examen', motif: 'Dossier transmis pour vérification' }).expect(200);
    expect(r.body.traitee_par).toBe('controleur');
  });

  it('les paramètres des règles sont modifiables sans code', async () => {
    const r = await api().patch('/api/v1/anomalies/regles/A002').set(as('admin'))
      .send({ parametres: { ecart_relatif_max: 0.5 }, motif: 'Ajustement du seuil après calibrage' }).expect(200);
    expect(r.body.parametres.ecart_relatif_max).toBe(0.5);
    const e = await api().post('/api/v1/anomalies/executer').set(as('controleur')).send({ regles: ['A002'] }).expect(201);
    expect(e.body.resultats[0].detectees).toBe(0);
  });
});

describe('Tableau de bord et audit', () => {
  it('produit les indicateurs nationaux', async () => {
    const r = await api().get('/api/v1/tableau-de-bord?exercice=2026').set(as('admin')).expect(200);
    expect(r.body.indicateurs.parcelles).toBe(37);
    expect(Number(r.body.indicateurs.potentiel)).toBeGreaterThan(0);
    expect(r.body.anomalies).toHaveLength(6);
  });

  it("le journal d'audit est intègre et immuable", async () => {
    const v = await api().get('/api/v1/audit/verification').set(as('auditeur')).expect(200);
    expect(v.body.integre).toBe(true);
    await expect(db.query('DELETE FROM snifi.journal_audit WHERE id = 1')).rejects.toMatchObject({ code: 'SN002' });
    await expect(db.query('UPDATE snifi.journal_audit SET motif = $1 WHERE id = 1', ['x'])).rejects.toMatchObject({ code: 'SN002' });
  });

  it("détecte une altération du journal", async () => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE snifi.journal_audit DISABLE TRIGGER journal_audit_no_update');
      await c.query("UPDATE snifi.journal_audit SET apres = '{\"superficie_m2\": 1}' WHERE id = 3");
      const r = await c.query('SELECT * FROM snifi.verifier_journal()');
      expect(r.rows[0].id).toBe('3');
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});
