# Changelog

Tous les changements notables sont documentés ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/)

---

## [5.0.0] — 2026-03-13

### Ajouté
- start_agent.py démarre maintenant les 7 couches Python complètes (Memory → Brain → Perception → Executor → Evolution → MCP Bridge → Queen)
- Tableau de bord start_agent.py affiche toutes les 7 couches avec statut
- STANDALONE_MODE=true par défaut pour éviter les 409 Conflict Telegram
- TELEGRAM_MODE=disabled documenté dans .env.example
- QUEEN_MAX_PARALLEL=3 ajouté dans .env.example
- 530 tests (287 pytest + 243 Jest) — +358 tests vs v3.2.0
- needs_confirm() : whitelist + regex — zéro faux positif sur curl -X DELETE
- is_blocked() : double couche regex + shlex tokenisation
- Circuit breaker par provider LLM dans brain.py
- _extract_json() : extracteur 3 passes dans queen.py
- _vital_loop_guardian() : auto-restart avec backoff 10s
- Anti-avalanche missions (_active_vital_missions)
- Cooldown 5min par type d'action autonome (_anomaly_cooldown)
- Archive des épisodes memory évincés (episodes_archive.jsonl)
- MCP Server Pencil.app (mcp_servers/pencil_mcp.js) — 8 outils AppleScript
- Dashboard complet : SwarmPage (5 stat cards + health checks) + GoalsPage (deadlines + filtres)
- PATCH /api/goals/:id/status endpoint
- agent_card.json version 5.0.0, SYSTEM_IDENTITY.md version 5.0.0

### Corrigé
- 409 Conflict Telegram : isolation queen.py / queen_oss.js via STANDALONE_MODE
- Faux positifs HITL : `curl -X DELETE` ne déclenche plus de confirmation
- vital_loop() crash sur réponse LLM non-JSON (utilise _extract_json())
- Missions fire-and-forget : anti-avalanche guard

---

## [Unreleased]

### Prévu
- Streaming temps réel dans Telegram
- Support missions multi-fichiers
- Amélioration pipeline computer-use

---

## [3.2.0] — 2026-03-11

### Ajouté
- Queen OSS v3.2 refactorisée — robustesse & optimisations
- Agent intent pipeline (`src/agents/intentPipeline.js`) — détection computer-use
- Planner agent (`src/agents/planner.js`) — décomposition de plans en steps
- Cron runner (`src/cron_runner.js`) — tâches planifiées
- Mode `--headless` pour déploiements VPS
- Worker pool Python (`src/worker_pool.py`) — exécution parallèle
- Vision continue (`src/voice_continuous.js`)
- Métriques et profiling agents

### Amélioré
- TypeScript strict sur `agentLoop.ts`, `provider.ts`, `toolRouter.ts`, `agentBridge.js`
- Gestion graceful shutdown (SIGINT/SIGTERM)
- Logs structurés avec contexte d'erreur

### Corrigé
- Fuite mémoire dans le HUD WebSocket
- Race condition dans le butterfly loop

---

## [3.1.0] — 2026-02-15

### Ajouté
- **Butterfly Loop OSS** — orchestration multi-agents 100% Ollama
- **Model Router** — auto-détection et assignation des rôles (stratège/architecte/worker/vision)
- **HUD WebSocket** — overlay Electron temps réel sur port 9001
- **Skill Factory** — génération de skills via LLM
- **Proactive Watcher** — surveillance et déclenchement autonome

### Modifié
- Migration vers Ollama-only (suppression dépendances cloud payantes)
- Refonte du dashboard React

---

## [3.0.0] — 2026-01-20

### Ajouté
- Architecture Ghost Swarm — hiérarchie multi-agents
- 19 modules MCP (os-control, terminal, vision, vault, skill-factory, rollback, janitor...)
- CLI `laruche` avec commander.js
- Dashboard HQ React/Vite (`http://localhost:8080`)
- Ghost-Monitor HUD Electron (overlay always-on-top)
- PM2 process manager avec ecosystem.config.js
- Mémoire vectorielle ChromaDB
- Système de rollback par snapshots
- Support multi-moniteurs

### Sécurité
- HITL obligatoire pour actions irréversibles
- PathValidator LFI — zéro path traversal
- ToolRegistry RBAC (USER/ADMIN/ROOT)
- AuditLogger JSON pour toutes les opérations
- Kill Switch `/killall` Telegram

---

## [2.x] — 2025-12

- Version expérimentale (non open source)

---

## [1.0.0] — 2025-10

- Proof of concept initial
