# SNIFI — Système National d'Intelligence Fiscale Immobilière

Prototype **MVP V1** : il implémente les 8 modules prioritaires du cahier des charges (§31).

> Donnée → identité → parcelle → bâtiment → événement → fiscalité → rapprochement → anomalie → risque → intelligence.

SNIFI ne qualifie jamais une anomalie de fraude. Il fournit des éléments objectifs à partir desquels
l'administration compétente décide s'il faut une vérification.

## Contenu

| # | Module MVP | Implémentation |
|---|------------|----------------|
| 01 | Utilisateurs / sécurité | JWT, RBAC sur 12 rôles (moindre privilège, refus par défaut), périmètre territorial, journal d'audit immuable chaîné SHA-256 |
| 02 | Propriétaires | Identifiant `PROP-…`, 7 types, recherche, modification motivée, fusion de doublons, biens liés |
| 03 | Parcelles | Identifiant immobilier `SNIFI-CI-ABJ-COC-00000001`, géométrie PostGIS, superficie juridique / géométrique, droits historisés avec quotes-parts |
| 04 | Bâtiments / unités | Parcelle → bâtiment → niveau → logement/local, usages, valeur locative, permis (source Urbanisme) |
| 05 | Cartographie | Couches GeoJSON (parcelles, bâtiments, zones fiscales, territoires) filtrées par emprise, carte MapLibre colorée par anomalies |
| 06 | Fiscalité | Règles **paramétrables** (aucun taux codé en dur), zones, exonérations, calcul explicable, liquidation, paiements, dossier fiscal, synthèse potentiel / liquidé / recouvré / écart |
| 07 | Transactions | 9 types d'événements, validation, répercussion automatique dans les droits |
| 08 | Anomalies | Moteur de rapprochement A001 à A006, seuils paramétrables, idempotent, clôture automatique des signaux disparus, cycle de traitement contrôlé |
| + | Tableau de bord | Indicateurs nationaux et territoriaux, potentiel fiscal et recouvrement |

### Règles d'anomalies

| Code | Rapprochement | Paramètres par défaut |
|------|---------------|-----------------------|
| A001 Construction non référencée | permis (Urbanisme) × bâtiments (SNIFI) | délai de 12 mois après le permis |
| A002 Incohérence de superficie | titre × géométrie cadastrale | écart > 10 % |
| A003 Mutation non actualisée | transaction validée × droits | délai de 30 jours |
| A004 Incohérence déclarative | déclaration × bâtiments connus | sous-déclaration > 15 % |
| A005 Valeur atypique | valeur/m² × médiane communale | < 0,5× ou > 2× la médiane (au moins 3 transactions) |
| A006 Bien non actualisé | ancienneté de la source | plus de 5 ans |

### Traçabilité (§27–28)

Toute écriture produit une entrée dans `snifi.journal_audit` : **qui, quoi, quand, avant, après, pourquoi, source**.

- Une mise à jour ou une suppression **sans motif** est refusée par la base elle-même (trigger), quel que soit le client.
- Le journal accepte uniquement des ajouts : UPDATE, DELETE et TRUNCATE y sont interdits.
- Chaque entrée est chaînée à la précédente par une empreinte SHA-256. `snifi.verifier_journal()` (et `GET /api/v1/audit/verification`) détecte toute altération faite après coup.

### Calcul fiscal explicable

```
montant = base × (1 − abattement) × taux × coefficient_zone × (1 − exonération) × quote_part
```

Chaque imposition garde le détail de ces facteurs dans `detail_calcul`. Le **montant théorique**
(simulation) reste séparé du **montant liquidé** (exigible), et une imposition liquidée n'est jamais recalculée.

## Architecture : GitHub + Vercel + Supabase

```
Navigateur ──► Vercel (Next.js, snifi/web) ──supabase-js──► Supabase
                                                             ├─ Auth (comptes, mots de passe, MFA)
                                                             ├─ API RPC : fonctions public.* (contrôle rôle + périmètre)
                                                             └─ PostgreSQL + PostGIS : schéma snifi (non exposé)
```

```
snifi/
├── supabase/
│   ├── migrations/        schéma · audit · référentiels · fonctions métier · API RPC
│   ├── seed.sql           jeu de démonstration FICTIF (Abidjan : Cocody, Yopougon)
│   └── demo_auth_users.sql comptes de démonstration Supabase Auth (à exécuter avant seed.sql)
├── web/                   Next.js (React, TypeScript) + MapLibre, déployé sur Vercel
└── tests/                 tests de bout en bout de l'API SQL (PostgreSQL + PostGIS local)
```

Le navigateur n'accède jamais aux tables. Chaque écran appelle une fonction de l'API
(`supabase.rpc('parcelles_lister', …)`) avec la session de l'utilisateur. La fonction :
- identifie le compte (`auth.uid()`) ;
- vérifie son rôle et son périmètre territorial ;
- transmet au journal d'audit l'auteur, le motif et la source de la modification.

## Mise en place

### 1. Supabase
1. Créez un projet Supabase.
2. Appliquez dans l'ordre les fichiers de `supabase/migrations/`, avec la CLI (`supabase db push`) ou dans l'éditeur SQL.
3. Pour la démonstration, exécutez `supabase/demo_auth_users.sql` puis `supabase/seed.sql`.
4. En production, créez les comptes depuis *Authentication* et attribuez à chacun un profil dans `snifi.profils` (rôle et territoire). Activez aussi la MFA.

### 2. Vercel
1. Importez le dépôt GitHub dans Vercel et réglez **Root Directory** sur `snifi/web`.
2. Définissez les variables `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY` (voir `web/.env.example`).
3. Chaque push déclenche un déploiement, avec une prévisualisation pour chaque pull request.

### 3. En local
```bash
cd snifi/web && cp .env.example .env.local   # renseigner l'URL et la clé du projet
npm install && npm run dev                     # http://localhost:3000
```

### Tests
Il faut PostgreSQL 16+ avec PostGIS. La base `snifi_test` est **supprimée puis recréée** à chaque exécution, et Supabase Auth y est simulé.
```bash
cd snifi/tests && npm install && PG_URL=postgres://user:pass@localhost:5432 npm test
```

## API (fonctions RPC Supabase)

| Domaine | Fonctions | Rôles en écriture |
|---------|-----------|-------------------|
| Session | `moi` | — |
| Propriétaires | `proprietaires_lister`, `proprietaire_detail`, `proprietaire_creer`, `proprietaire_modifier`, `proprietaire_fusionner` | admin, régional, agent fiscal, foncier |
| Parcelles | `parcelles_lister`, `parcelle_detail`, `parcelle_historique`, `parcelle_creer`, `parcelle_modifier`, `droit_ajouter` | admin, foncier |
| Bâtiments | `batiment_detail`, `batiment_creer`, `batiment_modifier`, `unite_ajouter`, `permis_creer` | admin, foncier, urbanisme, agent fiscal |
| Cartographie | `carto_parcelles(p_bbox)`, `carto_batiments`, `carto_zones_fiscales`, `carto_territoires` | lecture |
| Fiscalité | `fiscalite_regles`, `regle_fiscale_creer`, `fiscalite_calculer`, `fiscalite_liquider`, `paiement_enregistrer`, `exoneration_creer`, `dossier_fiscal`, `fiscalite_synthese` | admin, agent fiscal |
| Transactions | `transactions_lister`, `transaction_creer`, `transaction_valider`, `transaction_appliquer` | admin, foncier, notaire |
| Anomalies | `anomalies_regles`, `anomalie_regle_modifier`, `anomalies_executer`, `anomalies_lister`, `anomalie_traiter` | admin, contrôleur, agent fiscal |
| Audit | `audit_journal`, `audit_verifier` | admin, auditeur (lecture seule) |
| Pilotage | `tableau_de_bord`, `espace_proprietaire_biens` | lecture |

Les fonctions de modification prennent un paramètre `p_motif`, obligatoire (5 caractères minimum).

## Limites connues du prototype et suite (V1.1 → V3)

- **MFA** : Supabase Auth gère la double authentification (TOTP). L'écran d'enrôlement et l'exigence du niveau `aal2` pour les profils sensibles restent à ajouter.
- **Rôles de base de données** : en production, limiter l'accès au rôle propriétaire de la base (postgres), qui pourrait désactiver les triggers d'audit. Il faut aussi ancrer régulièrement la dernière empreinte du journal hors de la base (horodatage qualifié).
- Pas encore livrés : GED (Module 15), Data Hub d'import (V1.2), contrôles (V2.1), moteur de risque (V2). Les `poids` des règles d'anomalies sont déjà stockés pour l'indice de priorité explicable.
- Le fond de carte OpenStreetMap public sert uniquement à la démonstration. Prévoir un serveur de tuiles ou un orthophotoplan institutionnel.
- Les taux, zones, noms et montants du jeu de démonstration sont **fictifs**.
