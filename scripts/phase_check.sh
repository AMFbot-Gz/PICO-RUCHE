#!/bin/bash
set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; AMBER='\033[0;33m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0; BLOCK=false

ok()   { echo -e "${GREEN}✅${NC} $1"; ((PASS++)); }
warn() { echo -e "${AMBER}⚡${NC} $1"; ((WARN++)); }
fail() { echo -e "${RED}❌${NC} $1"; ((FAIL++)); BLOCK=true; }

echo ""; echo "🐝 PICO-RUCHE — Phase Check"; echo "================================"

echo ""; echo "PHASE 0 — Prérequis (bloquant)"
NODE_VER=$(node --version 2>/dev/null | tr -d 'v' | cut -d. -f1)
[ "${NODE_VER:-0}" -ge 20 ] && ok "Node.js $(node --version)" || fail "Node.js >= 20 requis"
PY_VER=$(python3 --version 2>/dev/null | awk '{print $2}' | cut -d. -f2)
[ "${PY_VER:-0}" -ge 9 ] && ok "Python $(python3 --version 2>/dev/null | awk '{print $2}')" || fail "Python >= 3.9 requis"
curl -s http://localhost:11434/api/tags > /dev/null 2>&1 && ok "Ollama actif" || fail "Ollama non démarré → ollama serve"
pm2 --version > /dev/null 2>&1 && ok "PM2 $(pm2 --version)" || fail "PM2 absent → npm install -g pm2"

echo ""; echo "PHASE 1 — Modèles Ollama"
MODELS=$(ollama list 2>/dev/null || echo "")
echo "$MODELS" | grep -qi "qwen3\|llama3" && ok "Stratège : $(echo "$MODELS" | grep -iE 'qwen3|llama3' | head -1 | awk '{print $1}')" || warn "Modèle stratège absent → ollama pull llama3:latest"
echo "$MODELS" | grep -qi "llama3.2" && ok "Worker : llama3.2:3b" || warn "Worker absent → ollama pull llama3.2:3b"
echo "$MODELS" | grep -qi "moondream\|llava" && ok "Vision : $(echo "$MODELS" | grep -iE 'moondream|llava' | head -1 | awk '{print $1}')" || warn "Vision absent → ollama pull moondream"

echo ""; echo "PHASE 2 — MLX (optionnel)"
python3 -c "import mlx_lm" 2>/dev/null && ok "MLX installé — boost M2 actif" || warn "MLX absent → npm run install-mlx"

echo ""; echo "PHASE 3 — .env"
[ -f ".env" ] || fail ".env absent → cp .env.example .env"
if [ -f ".env" ]; then
  source .env 2>/dev/null || true
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && ok "TELEGRAM_BOT_TOKEN" || fail "TELEGRAM_BOT_TOKEN vide"
  [ -n "${ADMIN_TELEGRAM_ID:-}" ] && ok "ADMIN_TELEGRAM_ID" || fail "ADMIN_TELEGRAM_ID vide"
  [ -n "${KIMI_API_KEY:-}" ] && ok "KIMI_API_KEY" || warn "KIMI_API_KEY absent"
fi

echo ""; echo "PHASE 4 — Self-repair"
which claude > /dev/null 2>&1 && ok "claude CLI" || warn "claude CLI absent"
which aider > /dev/null 2>&1 && ok "Aider" || warn "Aider absent → pip3 install aider-chat"

echo ""; echo "PHASE 5 — Tests"
npm run test:unit > /dev/null 2>&1 && ok "153 tests verts ✅" || fail "Tests échoués — ne pas déployer"

echo ""; echo "================================"
echo "Résultat : ✅ $PASS  ⚡ $WARN  ❌ $FAIL"
if [ "$BLOCK" = true ]; then echo -e "${RED}❌ Démarrage bloqué${NC}"; exit 1
else echo -e "${GREEN}✅ PICO-RUCHE prêt → npm start${NC}"; fi
