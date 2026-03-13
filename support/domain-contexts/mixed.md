# Contexte domaine — Missions mixtes PICO-RUCHE

## Rôles disponibles
- shell : commande terminal (ls, git, python3, npm, curl…)
- vision : capture et analyse d'écran (screencapture, analyse image)
- worker : traitement LLM générique (synthèse, analyse, rédaction)
- strategist : planification et décomposition de tâches complexes

## Niveaux de risque
- low : lecture seule, commandes non destructives, analyse
- medium : modification de fichiers, installation de paquets, redémarrage de services
- high : suppression, formatage, kill de processus critiques, shutdown

## Patterns courants
- Vérifier un état système → role: vision ou shell (risk: low)
- Générer ou modifier du code → role: worker (risk: medium)
- Exécuter un script → role: shell (risk: medium)
- Analyser des données → role: worker (risk: low)
- Planifier une mission complexe → role: strategist (risk: low)

## Couches disponibles
- perception (8002) : screenshots, scan système, fichiers récents
- brain (8003) : LLM Ollama (llama3, llama3.2:3b, moondream)
- executor (8004) : shell sandboxé, pyautogui, actions GUI
- memory (8006) : épisodes JSONL, world state, profil persistant
- evolution (8005) : génération skills, auto-réparation
- mcp_bridge (8007) : pont vers queen Node.js :3000
