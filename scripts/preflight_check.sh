#!/usr/bin/env bash
# =============================================================================
# PICO-RUCHE — Vérification pré-lancement (preflight_check.sh)
# Usage  : bash scripts/preflight_check.sh
# Retour : exit 0 si tout est OK, exit 1 si un composant critique est manquant
# =============================================================================

set -euo pipefail

# ── Couleurs ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}[OK]${NC}     $*"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC}   $*"; }
fail() { echo -e "  ${RED}[ERREUR]${NC} $*"; CRITICAL_ERRORS=$((CRITICAL_ERRORS + 1)); }
info() { echo -e "  ${BLUE}[INFO]${NC}   $*"; }

CRITICAL_ERRORS=0

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║          PICO-RUCHE — Vérification pré-lancement         ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# 1. Ollama — serveur démarré
# ─────────────────────────────────────────────────────────────────────────────
echo -e "${BOLD}[1] Ollama${NC}"
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

if curl -sf "${OLLAMA_URL}/api/tags" --max-time 3 > /tmp/pico_ollama_tags.json 2>/dev/null; then
    ok "Serveur Ollama accessible — ${OLLAMA_URL}"
else
    fail "Ollama inaccessible à ${OLLAMA_URL} — lancer : ollama serve"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Modèles Ollama requis
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[2] Modèles Ollama requis${NC}"
REQUIRED_MODELS=("llama3:latest" "llama3.2:3b" "moondream:latest")

if [[ -f /tmp/pico_ollama_tags.json ]]; then
    for model in "${REQUIRED_MODELS[@]}"; do
        if grep -q "\"${model}\"" /tmp/pico_ollama_tags.json 2>/dev/null; then
            ok "Modèle disponible : ${model}"
        else
            fail "Modèle manquant : ${model} — lancer : ollama pull ${model}"
        fi
    done
else
    warn "Impossible de vérifier les modèles (Ollama offline)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Ports 8001–8007 libres
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[3] Ports agent (8001–8007)${NC}"
PORTS=(8001 8002 8003 8004 8005 8006 8007)
PORT_NAMES=("queen" "perception" "brain" "executor" "evolution" "memory" "mcp_bridge")

for i in "${!PORTS[@]}"; do
    port="${PORTS[$i]}"
    name="${PORT_NAMES[$i]}"
    if lsof -i ":${port}" -sTCP:LISTEN -t >/dev/null 2>&1; then
        pid=$(lsof -i ":${port}" -sTCP:LISTEN -t 2>/dev/null | head -1)
        warn "Port ${port} (${name}) déjà occupé — PID ${pid}"
    else
        ok "Port ${port} (${name}) libre"
    fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 4. Fichier .env — TELEGRAM_BOT_TOKEN
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[4] Configuration .env${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
    warn ".env introuvable — copier .env.example en .env et remplir les valeurs"
else
    ok "Fichier .env présent"

    # TELEGRAM_BOT_TOKEN (warning seulement, pas bloquant)
    if grep -q "^TELEGRAM_BOT_TOKEN=.\+" "${ENV_FILE}" 2>/dev/null; then
        ok "TELEGRAM_BOT_TOKEN configuré"
    else
        warn "TELEGRAM_BOT_TOKEN vide dans .env — notifications Telegram désactivées"
    fi

    # ADMIN_TELEGRAM_ID (warning seulement)
    if grep -q "^ADMIN_TELEGRAM_ID=.\+" "${ENV_FILE}" 2>/dev/null; then
        ok "ADMIN_TELEGRAM_ID configuré"
    else
        warn "ADMIN_TELEGRAM_ID vide dans .env — HITL Telegram désactivé"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# 5. Python 3 + packages requis
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[5] Python 3 et dépendances${NC}"

if command -v python3 &>/dev/null; then
    PY_VERSION=$(python3 --version 2>&1)
    ok "Python3 disponible — ${PY_VERSION}"
else
    fail "python3 introuvable — installer via https://python.org ou homebrew"
fi

REQUIRED_PY_PACKAGES=("fastapi" "uvicorn" "httpx" "pydantic" "yaml" "pyautogui")
for pkg in "${REQUIRED_PY_PACKAGES[@]}"; do
    # yaml est importé via PyYAML
    import_name="${pkg}"
    [[ "${pkg}" == "yaml" ]] && import_name="yaml"
    if python3 -c "import ${import_name}" 2>/dev/null; then
        ok "Package Python : ${pkg}"
    else
        pip_name="${pkg}"
        [[ "${pkg}" == "yaml" ]] && pip_name="PyYAML"
        fail "Package Python manquant : ${pkg} — lancer : pip3 install ${pip_name}"
    fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 6. Node.js >= 20
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}[6] Node.js${NC}"

if command -v node &>/dev/null; then
    NODE_VERSION_FULL=$(node --version 2>&1)      # ex: v20.11.0
    NODE_MAJOR=$(echo "${NODE_VERSION_FULL}" | sed 's/v//' | cut -d. -f1)
    if [[ "${NODE_MAJOR}" -ge 20 ]]; then
        ok "Node.js ${NODE_VERSION_FULL} (>= 20)"
    else
        fail "Node.js ${NODE_VERSION_FULL} trop ancien — version >= 20 requise"
    fi
else
    fail "node introuvable — installer Node.js >= 20 via https://nodejs.org ou nvm"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Résumé
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════════════════════${NC}"
if [[ "${CRITICAL_ERRORS}" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}  Preflight OK — Aucune erreur critique. PICO-RUCHE peut demarrer.${NC}"
    echo -e "${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo ""
    exit 0
else
    echo -e "${RED}${BOLD}  Preflight ECHEC — ${CRITICAL_ERRORS} erreur(s) critique(s) detectee(s).${NC}"
    echo -e "  Corriger les erreurs ci-dessus avant de lancer l'agent."
    echo -e "${BOLD}══════════════════════════════════════════════════════════${NC}"
    echo ""
    exit 1
fi
