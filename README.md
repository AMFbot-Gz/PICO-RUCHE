<div align="center">

# 🐝 LaRuche — Ghost OS v5.0

### Système d'exploitation agentique autonome — 100% local

**Zéro cloud. Zéro abonnement. Votre machine, votre IA.**

---

[![Tests](https://img.shields.io/badge/tests-172%2F172-22C55E?style=flat-square)](test/)
[![Version](https://img.shields.io/badge/version-5.0.0-F5A623?style=flat-square)](CHANGELOG.md)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-7C3AED?style=flat-square)](LICENSE)
[![Ollama](https://img.shields.io/badge/Powered%20by-Ollama-FF6C37?style=flat-square)](https://ollama.com)

</div>

---

## Qu'est-ce que LaRuche ?

LaRuche est un **OS agentique multi-couches** qui transforme un Mac en système autonome capable de :

- **Percevoir** l'écran (AX tree cache différentiel, < 100ms)
- **Planifier** des objectifs longs termes (goal graph DAG)
- **Exécuter** des actions via 19 skills + 9 MCP servers
- **Apprendre** de chaque mission (mémoire épisodique + mémoire sémantique)
- **S'améliorer** automatiquement (skill factory évolutive, self-refactoring)
- **Se distribuer** sur plusieurs machines (swarm Ollama multi-nœuds)

---

## Quick Start (5 minutes)

1. `cp .env.example .env` et remplir `TELEGRAM_BOT_TOKEN` (optionnel — requis pour Telegram)
2. `make preflight` — vérifie ollama + modèles requis
3. `make install` — installe les dépendances Python et Node.js
4. `make start` — démarre l'essaim (7 couches)
5. `make status` — vérifie que tout tourne
6. Telegram : `/status` → reçoit l'état en temps réel

> **Mode sans Telegram** : mettre `STANDALONE_MODE=true` dans `.env` — la queen
> est alors disponible sur `http://localhost:8001` sans bot configuré.

```bash
# Raccourcis Makefile
make preflight   # vérifie les prérequis
make install     # installe les dépendances
make start       # démarre PICO-RUCHE
make status      # état de santé des 7 couches
make stop        # arrêt propre (graceful)
make logs        # tail -f des logs en direct
make clean       # supprime PIDs et logs
```

---

## Prérequis

```bash
node --version   # 20+
ollama serve     # Ollama doit tourner

ollama pull llama3.2:3b    # agent worker (requis)
ollama pull llama3:latest  # agent stratège (requis)
ollama pull llava:7b       # vision (optionnel)
ollama pull moondream:latest  # vision rapide (optionnel)
```

---

## Installation

```bash
git clone https://github.com/AMFbot-Gz/LaRuche.git
cd LaRuche
npm install
cp .env.example .env
```

Variables `.env` :

| Variable | Description | Requis |
|---|---|---|
| `STANDALONE_MODE` | `true` pour mode API sans Telegram | ➖ |
| `TELEGRAM_BOT_TOKEN` | Token bot Telegram | ➖ |
| `ADMIN_TELEGRAM_ID` | Votre ID Telegram | ➖ |
| `OLLAMA_HOST` | URL Ollama (défaut: `http://localhost:11434`) | ➖ |
| `QUEEN_MAX_PARALLEL` | Missions en parallèle max (défaut: `3`) | ➖ |
| `MISSION_TIMEOUT_MS` | Timeout global par mission (défaut: `300000`) | ➖ |
| `ANTHROPIC_API_KEY` | Fallback cloud Claude | ➖ |
| `OPENAI_API_KEY` | Fallback cloud GPT | ➖ |

---

## Démarrage

### Mode API REST (standalone)

```bash
STANDALONE_MODE=true node src/queen_oss.js
```

API disponible sur `http://localhost:3000`.

### Mode PM2 (production)

```bash
npm install -g pm2
pm2 start ecosystem.config.js --env production
pm2 logs laruche-queen
```

### Mode Docker

```bash
docker-compose up -d
```

Services :
- Queen API : `http://localhost:3000`
- Dashboard : `http://localhost:8080`
- Ollama : `http://localhost:11434`

### Dashboard React

```bash
cd dashboard && npm install && npm run dev -- --port 3001
# → http://localhost:3001
```

---

## Utilisation rapide

### Lancer une mission

```bash
curl -X POST http://localhost:3000/api/mission \
  -H "Content-Type: application/json" \
  -d '{"command": "prends un screenshot du bureau"}'
# → { "missionId": "m-xxx", "status": "pending" }
```

### Suivre l'état

```bash
curl http://localhost:3000/api/missions/m-xxx
```

### Via Telegram

```
/mission Analyse ce repo et génère un rapport
```

---

## Architecture

```
Entrées
  Telegram / API REST / CLI / HUD
         ↓
Queen OSS (queen_oss.js)
  ├── Queue FIFO (max 3 parallèles, 503 si saturé)
  ├── Rate limiting (30 req/min par IP)
  └── WebSocket HUD :9001
         ↓
Pipeline 3 couches (< 0.3s → < 30s)
  ├── 1. routeByRules()    — 40+ règles regex (instant)
  ├── 2. recall()          — mémoire apprise cosine (instant)
  └── 3. LLM planner       — llama3.2:3b (~10-30s)
         ↓
Orchestration multi-agents
  ├── Stratège    (llama3:latest)   — décomposition
  ├── Architecte  (llama3.2:3b)    — code & debug
  ├── Worker      (llama3.2:3b)    — exécution
  ├── Vision      (llava:7b)       — analyse écran
  └── Synthèse    (llama3:latest)  — fusion résultats
         ↓
Exécution (executor.js)
  ├── 19 Skills dynamiques
  └── 9 MCP Servers
         ↓
Apprentissage
  ├── missionMemory   — plans appris + embeddings Ollama
  └── episodicMemory  — expériences complètes JSONL
```

---

## Couches cognitives v5/v6

| Couche | Module | Rôle |
|---|---|---|
| **Perception** | `src/perception/` | AX tree cache SHA-256, TTL par app, < 100ms |
| **World Model** | `src/worldmodel/` | Mémoire structurelle UI, simulation plan |
| **Temporal** | `src/temporal/` | Goal graph DAG, scheduler priorités |
| **Simulation** | `src/simulation/` | Risk estimator, successProbability avant exec |
| **Evolution** | `src/evolution/` | Skill factory auto, failure detector |
| **Mémoire épisodique** | `src/memory/episodic/` | 500 épisodes JSONL + similarity search |
| **Swarm** | `src/swarm/` | Multi-nœuds Ollama, EWMA latence |
| **Market** | `src/market/` | Enchères agents, reputation system |
| **Self-dev** | `src/selfdev/` | Analyse repo, suggestions patches |
| **Ghost HUD** | `hud/ghost-overlay/` | Overlay AR transparent Electron |

---

## Sous-agents spécialisés

| Agent | Modèle | Rôle | Skills autorisés |
|---|---|---|---|
| **DevAgent** | llama3.2:3b | Code, git, npm, tests | run_command, read_file, run_shell |
| **OpsAgent** | llama3.2:3b | Santé système, logs, disk | run_command, list_big_files |
| **KnowledgeAgent** | llama3:latest | Mémoire, docs, vault | read_file, summarize_project |

```bash
# Dispatcher un sous-agent
curl -X POST http://localhost:3000/api/subagents/dev_agent/dispatch \
  -H "Content-Type: application/json" \
  -d '{"task": "audit les dépendances npm et liste les vulnérabilités"}'
```

---

## Skills disponibles (19)

| Catégorie | Skills |
|---|---|
| **Perception** | `take_screenshot`, `screen_elements`, `accessibility_reader` |
| **Action sémantique** | `find_element`, `smart_click`, `wait_for_element` |
| **Contrôle macOS** | `open_app`, `goto_url`, `type_text`, `press_key`, `press_enter` |
| **Système** | `run_command`, `run_shell`, `read_file`, `list_big_files` |
| **Réseau** | `http_fetch` |
| **Analyse** | `summarize_project` |

---

## API complète

### Missions

```
POST /api/mission              Lance une mission
GET  /api/missions             Historique (pagination)
GET  /api/missions/:id         État temps réel
POST /api/mission/:id/cancel   Annule une mission
GET  /api/queue                Stats queue (pending/running)
```

### Agents

```
GET  /api/agents               État des agents
GET  /api/subagents            Sous-agents disponibles
POST /api/subagents/:id/dispatch  Lance une tâche sur un sous-agent
GET  /api/subagents/:id/stats  Stats d'un sous-agent
```

### Système

```
GET  /api/status               État global + cognitiveMetrics
GET  /api/health               Healthcheck
GET  /api/system               CPU / RAM / Disque
GET  /api/logs                 Derniers logs
```

### Mémoire & Apprentissage

```
GET  /api/memory               Stats mémoire sémantique
DELETE /api/memory/forget      Oublie une route
GET  /api/memory/episodes      Mémoire épisodique
POST /api/memory/episodes/search  Recherche épisodes similaires
```

### Objectifs (Temporal Reasoner)

```
GET  /api/goals                Liste des objectifs
POST /api/goals                Ajoute un objectif
DELETE /api/goals/:id          Supprime un objectif
GET  /api/goals/schedule       Planning priorisé
```

### Swarm & Market

```
GET  /api/swarm/nodes          Nœuds Ollama du swarm
GET  /api/swarm/stats          Stats du swarm
GET  /api/market/stats         Réputation des agents
```

### World Model & Simulation

```
GET  /api/worldmodel/stats         Stats du world model
GET  /api/worldmodel/:appName      Modèle d'une app
DELETE /api/worldmodel/:appName    Oublie une app
POST /api/simulate                 Simule une action
```

### Évolution & Self-dev

```
GET  /api/evolution/skills     Stats skills (taux de succès)
POST /api/evolution/trigger    Force génération d'un nouveau skill
GET  /api/selfdev/analyze      Analyse le code du repo
```

---

## Sécurité

| Feature | Description |
|---|---|
| **HITL** | Validation humaine pour actions à risque > 0.5 |
| **Sandbox terminal** | Whitelist binaires + blocage métacaractères |
| **PathValidator** | Bloque traversals et LFI |
| **Rate limiting** | 30 req/min par IP |
| **Queue saturation** | 503 si > 100 missions en attente |
| **Audit trail** | JSON log de toutes les opérations |
| **Kill switch** | `/killall` via Telegram — stop global < 3s |

---

## Swarm multi-machines

Pour utiliser plusieurs machines Ollama, éditer `config/swarm_nodes.yml` :

```yaml
swarm:
  enabled: true
  nodes:
    - id: mac-local
      url: http://localhost:11434
      models: [llama3:latest, llama3.2:3b]
      role: primary
      maxConcurrency: 3
    - id: pc-vision
      url: http://192.168.1.42:11434
      models: [llava:13b]
      role: vision
      maxConcurrency: 2
```

---

## Tests

```bash
npm run test:unit    # 172 tests unitaires (2.7s)
npm run test:smoke   # Smoke tests API (serveur requis)
npm run test:all     # Tout
```

---

## Structure du projet

```
LaRuche/
├── src/
│   ├── queen_oss.js          # Entry point
│   ├── agents/               # Pipeline multi-agents
│   ├── perception/           # AX tree cache différentiel
│   ├── worldmodel/           # Mémoire structurelle UI
│   ├── temporal/             # Goal graph + scheduler
│   ├── simulation/           # Risk estimator
│   ├── evolution/            # Skill factory auto-évolutive
│   ├── memory/episodic/      # Mémoire épisodique
│   ├── swarm/                # Multi-nœuds Ollama
│   ├── market/               # Enchères + réputation
│   ├── selfdev/              # Self-refactoring
│   ├── subagents/            # DevAgent/OpsAgent/KnowledgeAgent
│   ├── learning/             # missionMemory (sémantique)
│   ├── llm/                  # callLLM + provider
│   ├── api/                  # Routes REST
│   └── skills/               # Runtime skill loader
├── skills/                   # 19 skills exécutables
├── mcp_servers/              # 9 serveurs MCP
├── dashboard/                # React 18 + Vite
├── hud/                      # Electron + Ghost Overlay AR
├── config/                   # agents.yml, swarm_nodes.yml, perception.yml
├── test/                     # 172 tests Jest + smoke
├── data/                     # learned_routes.json, episodes.jsonl, goals.json
└── ecosystem.config.js       # PM2 production config
```

---

## Contribuer

1. Fork le repo
2. `git checkout -b feat/ma-feature`
3. `npm run test:unit` — 172 tests doivent passer
4. Ouvre une PR

---

<div align="center">

**LaRuche v5.0 "Ghost OS" — Votre machine. Vos agents. Votre ruche.**

[![GitHub](https://img.shields.io/github/followers/AMFbot-Gz?style=social)](https://github.com/AMFbot-Gz)

</div>
