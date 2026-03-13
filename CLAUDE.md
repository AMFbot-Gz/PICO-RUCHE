# PICO-RUCHE — Ingénieur de référence

## Vision
Agent autonome hybride 100% local — Intel Core i7-9750H 16GB.
Node.js Ghost OS v5.0.0 + 7 couches Python FastAPI + 19 skills MCP.
Zéro cloud requis. Boucle vitale 30s. HITL Telegram.

## Architecture complète

```
Queen Node.js (queen_oss.js)     :3000   ← point d'entrée principal
├── Butterfly Loop (plan → workers → synthèse)
├── Computer Use (intentPipeline → skills macOS)
├── 19 Skills (skills/)
├── MCP Routes (/mcp/*)  ← src/api/mcp_routes.js
└── WebSocket HUD :9001

7 Couches Python FastAPI
├── Queen Python     :8001  agent/queen.py       ← orchestrateur + HITL + Telegram
├── Perception       :8002  agent/perception.py  ← screenshots + vision
├── Brain            :8003  agent/brain.py       ← LLM → plan JSON
├── Executor         :8004  agent/executor.py    ← shell sandboxé
├── Evolution        :8005  agent/evolution.py   ← auto-amélioration skills
├── Memory           :8006  agent/memory.py      ← épisodes + persistance
└── MCP Bridge       :8007  agent/mcp_bridge.py  ← proxy Python → /mcp/* Node.js
```

## Commandes essentielles

```bash
# Vérifier avant tout
make preflight                        # ollama + modèles + ports + .env

# Lancer l'essaim (2 terminaux séparés)
python3 start_agent.py                # 7 couches Python (ordre: Brain→Queen)
STANDALONE_MODE=true node src/queen_oss.js  # queen Node.js

# Ou avec pm2
pm2 start ecosystem.config.js --env production

# État
python3 scripts/status_agent.py       # tableau 8 couches + latences
make status

# Tests
npm test                              # 185 tests Jest
make test

# Arrêter
python3 stop_agent.py
make stop
```

## APIs Node.js :3000

```
POST /api/mission          ← lancer une mission
GET  /api/health           ← {"ok":true,"ts":...}
GET  /api/agents           ← état swarm
GET  /api/system           ← CPU/RAM/Disque
GET  /api/skills           ← 19 skills disponibles
GET  /api/status           ← status global
POST /mcp/os-control       ← click, typeText, screenshot, keyPress
POST /mcp/terminal         ← exec, execSafe, listProcesses
POST /mcp/vision           ← analyzeScreen, findElement
POST /mcp/vault            ← storeExperience, findSimilar
POST /mcp/rollback         ← createSnapshot, restore
POST /mcp/skill-factory    ← createSkill, evolveSkill
POST /mcp/janitor          ← purgeTemp, rotateLogs, gcRAM
GET  /mcp/health           ← état 7 routes MCP
```

## APIs Python Queen :8001

```
POST /mission              ← {"command": str, "priority": int}
GET  /missions             ← historique SQLite
GET  /status               ← état 7 couches via /health
GET  /hitl/queue           ← actions HITL en attente
GET  /health               ← {"status":"ok","vital_loop":bool,"hitl_pending":int}
POST /telegram/webhook     ← webhook Telegram
```

## Telegram HITL

- `/status` → état de l'essaim
- `/mission <texte>` → lancer une mission
- Action risque HIGH → message "ok-XXXX / non-XXXX" avec countdown 120s
- `ok-XXXX` → approuve et exécute
- `non-XXXX` → annule
- Timeout 120s → auto-annulation

## Modèles Ollama actifs

| Rôle | Modèle |
|------|--------|
| Stratège | llama3:latest |
| Worker | llama3.2:3b |
| Vision | moondream:latest |
| Compresseur | llama3.2:3b |
| Vision HD | llava:7b |

## Structure des fichiers clés

```
agent_config.yml          ← config centrale (ports, modèles, sécurité)
.env                      ← TELEGRAM_BOT_TOKEN + ADMIN_TELEGRAM_ID
start_agent.py            ← démarrage ordonné + health checks + PIDs
stop_agent.py             ← arrêt gracieux SIGTERM→SIGKILL
scripts/preflight_check.sh ← vérification pré-lancement
scripts/status_agent.py   ← tableau de bord couches
Makefile                  ← make start/stop/status/test/preflight
ecosystem.config.js       ← pm2 config (Node.js + 7 Python)
agent/                    ← 7 couches Python + 4 skills Python
skills/                   ← 19 skills Node.js
src/queen_oss.js          ← queen principale Node.js
src/api/mcp_routes.js     ← 7 routes MCP implémentées
mcp_servers/              ← 9 MCP servers (os-control, terminal, vision...)
```

## Sécurité

- Patterns bloqués : `rm -rf /`, fork bomb, `dd if=/dev/zero`, `mkfs`, `shutdown`, `reboot`
- Shell timeout max 30s, output tronqué à 10k chars
- HITL obligatoire pour risque HIGH
- pyautogui failsafe actif (coin haut-gauche = arrêt)

## Tests

```bash
make test                 # pytest (Python) + Jest (Node.js) — total ~340 tests
npm test                  # 185 tests Jest (21 suites)
python3 -m pytest tests/  # ~155 tests Python
npm run test:smoke        # smoke tests
```

## Variables .env requises

```bash
TELEGRAM_BOT_TOKEN=       # @BotFather
ADMIN_TELEGRAM_ID=        # @userinfobot
STANDALONE_MODE=false
OLLAMA_HOST=http://localhost:11434
HITL_TIMEOUT_SECONDS=120
CHIMERA_SECRET=           # secret HMAC pour la sécurité Chimera Bus
VOICE_ENABLED=false
```

## Patterns de développement

### Ajouter un skill Node.js
```bash
mkdir skills/mon_skill
# Créer skill.js (export default { run }) + manifest.json
# Ajouter dans skills/registry.json
```

### Ajouter un skill Python
```python
# Créer agent/skills/mon_skill.py
# Importer et appeler depuis agent/queen.py si besoin
```

### Modifier la boucle vitale
- Interval : `perception.interval_seconds` dans agent_config.yml
- Logique : `vital_loop()` dans agent/queen.py
- Auto-act seulement sur risque `low`

### Débugger une couche
```bash
# Logs live
tail -f agent/logs/<couche>.log

# Tester endpoint directement
curl http://localhost:<port>/health
curl -X POST http://localhost:8003/think -H "Content-Type: application/json" \
  -d '{"mission": "test", "mission_type": "mixed"}'
```
