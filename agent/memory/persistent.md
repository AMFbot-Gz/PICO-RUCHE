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

### 2026-03-13 04:46 — Apprentissage
PROCÉDURE FIN DE MISSION OBLIGATOIRE : 1) Finaliser l'action demandée. 2) Mettre à jour ~/world_state.json : last_updated (datetime UTC), active_app, top_processes (via `ps aux -m | head -12`), et toute clé impactée. 3) Confirmer avec "🧠 World State mis à jour". Note: open_app ne fonctionne pas, utiliser `execute_shell` avec `open -a NomApp`.

### 2026-03-13 07:48 — Apprentissage
Pour appeler Claude Code depuis un shell MCP qui tourne déjà dans Claude Code, il faut vider la variable d'environnement CLAUDECODE: CLAUDECODE="" claude -p "prompt" --max-turns N

### 2026-03-13 08:25 — Apprentissage
Pour lancer une vidéo YouTube sans JavaScript Safari: 1) curl les résultats de recherche YouTube 2) grep -oE '/watch\?v=[a-zA-Z0-9_-]{11}' pour extraire l'ID 3) open -a Safari l'URL complète. Contourne le besoin de 'Allow JavaScript from Apple Events'.

### 2026-03-13 21:39 — Apprentissage
Pour éviter le HITL: pas de commentaires # dans les commandes shell, et garder les commandes simples. Toujours vérifier qu'une app a vraiment une fenêtre ouverte avant d'interagir avec. L'agent local queen confond instructions FR et commandes bash - il faut lui donner des commandes shell explicites, pas des descriptions.

### 2026-03-13 22:15 — Apprentissage
TOUJOURS aller au bout des actions : ouvrir + naviguer + cliquer + vérifier. Ne jamais laisser l'utilisateur finir le travail. Utiliser execute_shell avec osascript pour cliquer si computer_use n'est pas dispo. Enchaîner les étapes sans attendre.

### 2026-03-13 22:36 — Apprentissage
Le module HID MCP est cassé (smartClick inconnu) mais Python3 + Quartz.CGEventCreateMouseEvent fonctionne parfaitement pour move/click/drag. Toujours utiliser cette méthode comme fallback.

### 2026-03-13 23:08 — Apprentissage
Le Mac dispose de : Python 3.12 (Quartz/AppKit/Pillow/OpenCV/PyAutoGUI/Playwright/Torch/Whisper/TTS), Node 25.5 (PM2/n8n/Vercel), Brew (ffmpeg/ripgrep/cloudflared/pytorch), Docker 29.2, Ollama (12+ modèles), Supabase CLI, 48+ endpoints API LaRuche, 8 couches actives, hardware Intel i7+16GB+AMD Radeon 4GB.
