# ============================================================
# PICO-RUCHE — Makefile
# Usage : make <cible>
# ============================================================

.PHONY: start stop status test test-python preflight install logs clean help

# Valeurs par défaut
PYTHON    := python3
LOGS_DIR  := agent/logs
PIDS_DIR  := agent/.pids

# ------------------------------------------------------------
# Cibles principales
# ------------------------------------------------------------

## Démarre l'essaim PICO-RUCHE (7 couches)
start:
	$(PYTHON) start_agent.py

## Arrête proprement tous les services
stop:
	$(PYTHON) stop_agent.py

## Affiche l'état de santé de toutes les couches
status:
	$(PYTHON) scripts/status_agent.py

## Lance les tests Python pytest
test-python:
	$(PYTHON) -m pytest tests/ -v --tb=short

## Lance la suite de tests complète (pytest + Jest unit + intégration)
test: test-python
	npm test

## Vérifie les prérequis (ollama, modèles, .env, dépendances)
preflight:
	bash scripts/phase_check.sh

## Installe les dépendances Python et Node.js
install:
	$(PYTHON) -m pip install -r requirements.txt
	npm install

## Suit les logs en temps réel (toutes les couches)
logs:
	@if ls $(LOGS_DIR)/*.log 1>/dev/null 2>&1; then \
		tail -f $(LOGS_DIR)/*.log; \
	else \
		echo "Aucun log trouvé dans $(LOGS_DIR)/"; \
	fi

## Supprime les PID files et les logs
clean:
	@rm -rf $(PIDS_DIR)
	@if ls $(LOGS_DIR)/*.log 1>/dev/null 2>&1; then \
		rm -f $(LOGS_DIR)/*.log; \
		echo "Logs supprimés."; \
	fi
	@echo "Nettoyage terminé."

# ------------------------------------------------------------
# Aide
# ------------------------------------------------------------

## Affiche cette aide
help:
	@echo ""
	@echo "🐝 PICO-RUCHE — commandes disponibles"
	@echo "────────────────────────────────────────"
	@grep -E '^##' $(MAKEFILE_LIST) | sed 's/## /  /'
	@echo ""
	@echo "Exemples :"
	@echo "  make preflight   # vérifie ollama + modèles"
	@echo "  make install     # installe les dépendances"
	@echo "  make start       # démarre l'essaim"
	@echo "  make status      # surveille les couches"
	@echo "  make stop        # arrêt propre"
	@echo ""

.DEFAULT_GOAL := help
