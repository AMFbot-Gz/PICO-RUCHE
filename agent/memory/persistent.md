# PICO-RUCHE — Mémoire Persistante
## Profil système
- Version : Ghost OS v5.0.0 + Agent Vivant Hybride v1.0
- Hardware : Mac M2 16GB
- Architecture : Python FastAPI (couches 8001-8007) + Node.js MCP (19 modules)
- Modèles : Ollama llama3:latest (stratège) · llama3.2:3b (worker) · moondream:latest (vision)
- Boucle vitale : 30 secondes
- Démarrage : python3 start_agent.py

## Capacités actives
- Computer use : PyAutoGUI (souris · clavier · écran)
- Vision : Moondream via Ollama
- Shell : sandboxé avec patterns bloqués
- Self-repair : Claude Code CLI
- MCP : modules Node.js via mcp_bridge.py
- Mémoire : épisodique JSONL + SQLite missions + world state JSON

## Missions réussies
[Rempli automatiquement]

## Apprentissages
[Rempli automatiquement par evolution.py]
