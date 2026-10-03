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

## Architecture

```
snifi/
├── db/
│   ├── migrations/   001 schéma · 002 audit · 003 référentiels · 004 fonctions métier
│   └── seed/demo.sql jeu de démonstration FICTIF (Abidjan : Cocody, Yopougon)
├── api/              NestJS + pg (PostgreSQL/PostGIS) — /api/v1
└── web/              Next.js (React, TypeScript) + MapLibre
```

## Démarrage

### Avec Docker

```bash
cd snifi
docker compose up --build
# http://localhost:3000 — comptes : admin, agent, controleur, foncier, auditeur / snifi2026
```

### En local (PostgreSQL 16 + PostGIS 3)

```bash
# base : createdb snifi (utilisateur snifi / snifi) — ou définir DATABASE_URL
cd snifi/api && npm install
npm run db:seed          # migrations + jeu de démonstration
npm run dev              # API sur http://localhost:3001/api/v1

cd ../web && npm install
npm run dev              # interface sur http://localhost:3000 (proxy /api/v1 → API)
```

Pour alimenter la démonstration, lancez dans l'interface **Fiscalité → Calculer** puis **Liquider**, et **Anomalies → Exécuter le moteur**.

### Tests

Ce sont des tests de bout en bout sur une vraie base PostGIS. La base `snifi_test` est **remise à zéro** à chaque exécution.

```bash
createdb snifi_test
cd snifi/api && npm test
```

Ils couvrent : authentification et RBAC, périmètre territorial, identifiants SNIFI, motif obligatoire,
historique avant/après, mutations, cartographie, calcul, liquidation et paiement, détection et idempotence
des 6 règles, cycle de traitement des anomalies, intégrité et immuabilité du journal.

## API (extrait)

| Méthode | Route | Rôles |
|---------|-------|-------|
| POST | `/auth/connexion` | public |
| GET/POST/PATCH | `/proprietaires`, `/proprietaires/:id`, `POST /proprietaires/:id/fusion` | lecture institutionnelle / foncier, fiscal |
| GET/POST/PATCH | `/parcelles`, `/parcelles/:id`, `/parcelles/:id/historique`, `POST /parcelles/:id/droits` | lecture / service foncier |
| POST/PATCH | `/batiments`, `/batiments/:id/unites`, `/permis` | foncier, urbanisme, fiscal |
| GET | `/cartographie/{parcelles,batiments,zones-fiscales,territoires}?bbox=o,s,e,n` | lecture |
| GET/POST | `/fiscalite/{regles,calcul,liquidation,paiements,exonerations,synthese}`, `/fiscalite/dossier/:parcelleId` | fiscal |
| GET/POST | `/transactions`, `/transactions/:id/{valider,appliquer}` | foncier, notaire |
| GET/POST/PATCH | `/anomalies`, `/anomalies/executer`, `/anomalies/regles/:code` | contrôleur, fiscal |
| GET | `/audit`, `/audit/verification` | auditeur, admin |
| GET | `/tableau-de-bord`, `/espace-proprietaire/biens` | lecture / propriétaire |

Toute requête de modification (PATCH, action) doit porter un `motif` dans le corps, ou dans l'en-tête `X-Snifi-Motif` encodé en URI.

## Limites connues du prototype et suite (V1.1 → V3)

- **IAM / MFA** : authentification locale JWT pour le prototype. En production, elle est déléguée à Keycloak ou à l'IAM institutionnel (OIDC + MFA). La garde RBAC reste la même.
- **Rôles de base de données** : en production, l'API doit se connecter avec un rôle sans droits DDL, pour qu'elle ne puisse pas désactiver les triggers d'audit. Il faut aussi ancrer régulièrement la dernière empreinte du journal hors de la base (horodatage qualifié).
- Pas encore livrés : GED (Module 15), Data Hub d'import (V1.2), contrôles (V2.1), moteur de risque (V2). Les `poids` des règles d'anomalies sont déjà stockés pour l'indice de priorité explicable.
- Le fond de carte OpenStreetMap public sert uniquement à la démonstration. Prévoir un serveur de tuiles ou un orthophotoplan institutionnel.
- Les taux, zones, noms et montants du jeu de démonstration sont **fictifs**.
