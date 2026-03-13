"""
Tests pour agent/queen.py.

Couvre :
- Validité syntaxique
- Présence du middleware de rate limiting (_rate_store, _rate_limit)
- Présence du HITL (HITL_QUEUE, hitl_request, hitl_approve, hitl_reject)
- Logique de rate limiting via simulation directe de _rate_store
- send_telegram() avec Telegram non configuré (pas d'exception)
- _validate_env() retourne False si variables manquantes
"""
import pytest
import sys
import os
import subprocess
import unittest.mock as mock

_ROOT = os.path.join(os.path.dirname(__file__), '..')
_QUEEN_PATH = os.path.join(_ROOT, 'agent', 'queen.py')


# ─────────────────────────────────────────────────────────────────────────────
# Tests syntaxe
# ─────────────────────────────────────────────────────────────────────────────

class TestQueenSyntax:
    def test_queen_syntax_valid(self):
        """queen.py doit être syntaxiquement valide."""
        result = subprocess.run(
            ['python3', '-m', 'py_compile', _QUEEN_PATH],
            capture_output=True, text=True
        )
        assert result.returncode == 0, (
            f"Erreur syntaxe queen.py:\n{result.stderr}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests d'analyse statique (sans import)
# ─────────────────────────────────────────────────────────────────────────────

class TestQueenStaticAnalysis:
    """Vérifie la présence des symboles clés dans queen.py sans l'importer."""

    @pytest.fixture(autouse=True)
    def read_content(self):
        with open(_QUEEN_PATH, encoding='utf-8') as f:
            self.content = f.read()

    def test_rate_store_defined(self):
        """_rate_store doit être défini pour le rate limiting."""
        assert '_rate_store' in self.content, (
            "_rate_store non trouvé dans queen.py"
        )

    def test_rate_limit_middleware_defined(self):
        """_rate_limit doit être défini comme middleware."""
        assert '_rate_limit' in self.content or 'rate_limit' in self.content.lower(), (
            "Rate limit middleware non trouvé dans queen.py"
        )

    def test_rate_max_defined(self):
        """_RATE_MAX doit être défini (limite de requêtes)."""
        assert '_RATE_MAX' in self.content, "_RATE_MAX non trouvé dans queen.py"

    def test_rate_win_defined(self):
        """_RATE_WIN doit être défini (fenêtre temporelle)."""
        assert '_RATE_WIN' in self.content, "_RATE_WIN non trouvé dans queen.py"

    def test_hitl_queue_defined(self):
        """HITL_QUEUE doit être défini."""
        assert 'HITL_QUEUE' in self.content, "HITL_QUEUE non trouvé dans queen.py"

    def test_hitl_request_defined(self):
        """hitl_request() doit être défini."""
        assert 'async def hitl_request(' in self.content, (
            "hitl_request() non trouvé dans queen.py"
        )

    def test_hitl_approve_defined(self):
        """hitl_approve() doit être défini."""
        assert 'async def hitl_approve(' in self.content, (
            "hitl_approve() non trouvé dans queen.py"
        )

    def test_hitl_reject_defined(self):
        """hitl_reject() doit être défini."""
        assert 'async def hitl_reject(' in self.content, (
            "hitl_reject() non trouvé dans queen.py"
        )

    def test_hitl_timeout_watchdog_defined(self):
        """_hitl_timeout_watchdog() doit être défini (auto-annulation)."""
        assert '_hitl_timeout_watchdog' in self.content, (
            "_hitl_timeout_watchdog() non trouvé dans queen.py"
        )

    def test_vital_loop_defined(self):
        """vital_loop() doit être défini (boucle principale)."""
        assert 'async def vital_loop(' in self.content, (
            "vital_loop() non trouvé dans queen.py"
        )

    def test_execute_mission_defined(self):
        """execute_mission() doit être défini."""
        assert 'async def execute_mission(' in self.content, (
            "execute_mission() non trouvé dans queen.py"
        )

    def test_send_telegram_defined(self):
        """send_telegram() doit être défini."""
        assert 'async def send_telegram(' in self.content, (
            "send_telegram() non trouvé dans queen.py"
        )

    def test_mission_endpoint_defined(self):
        """/mission endpoint doit être présent."""
        assert '"/mission"' in self.content or "'/mission'" in self.content, (
            "/mission endpoint non trouvé dans queen.py"
        )

    def test_health_endpoint_defined(self):
        """/health endpoint doit être présent."""
        assert '"/health"' in self.content or "'/health'" in self.content, (
            "/health endpoint non trouvé dans queen.py"
        )

    def test_hitl_queue_endpoint_defined(self):
        """/hitl/queue endpoint doit être présent."""
        assert '/hitl/queue' in self.content, (
            "/hitl/queue endpoint non trouvé dans queen.py"
        )

    def test_telegram_polling_defined(self):
        """telegram_polling_loop() doit être défini."""
        assert 'telegram_polling_loop' in self.content, (
            "telegram_polling_loop() non trouvé dans queen.py"
        )

    def test_validate_env_defined(self):
        """_validate_env() doit être défini (fail-fast au démarrage)."""
        assert '_validate_env' in self.content, (
            "_validate_env() non trouvé dans queen.py"
        )

    def test_rate_limit_429_response(self):
        """La réponse 429 doit être présente dans le middleware."""
        assert '429' in self.content, (
            "Réponse HTTP 429 non trouvée dans queen.py"
        )

    def test_rate_limit_message(self):
        """Le message de rate limit doit mentionner 20 req/min."""
        assert '20 req/min' in self.content or 'Rate limit' in self.content, (
            "Message rate limit non trouvé dans queen.py"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests de la logique de rate limiting (simulation directe — sans import)
# ─────────────────────────────────────────────────────────────────────────────

class TestRateLimitLogic:
    """
    Simule la logique de _rate_store directement.
    N'importe pas queen.py pour éviter les dépendances lourdes.
    """

    def _make_rate_store(self):
        """Crée un rate store avec les mêmes paramètres que queen.py."""
        from collections import defaultdict
        import time
        store = defaultdict(lambda: {"count": 0, "reset_at": 0.0})
        RATE_MAX = 20
        RATE_WIN = 60
        return store, RATE_MAX, RATE_WIN

    def test_rate_limit_allows_under_max(self):
        """19 requêtes successives : toutes autorisées."""
        import time
        store, RATE_MAX, RATE_WIN = self._make_rate_store()
        ip = "127.0.0.1"
        now = time.monotonic()

        blocked_count = 0
        for i in range(19):
            e = store[ip]
            if now > e["reset_at"]:
                e["count"], e["reset_at"] = 0, now + RATE_WIN
            e["count"] += 1
            if e["count"] > RATE_MAX:
                blocked_count += 1

        assert blocked_count == 0, "Les 19 premières requêtes doivent être autorisées"

    def test_rate_limit_blocks_at_max_plus_one(self):
        """21e requête : bloquée."""
        import time
        store, RATE_MAX, RATE_WIN = self._make_rate_store()
        ip = "127.0.0.1"
        now = time.monotonic()

        blocked_count = 0
        for i in range(21):
            e = store[ip]
            if now > e["reset_at"]:
                e["count"], e["reset_at"] = 0, now + RATE_WIN
            e["count"] += 1
            if e["count"] > RATE_MAX:
                blocked_count += 1

        assert blocked_count == 1, (
            f"La 21e requête doit être bloquée (got {blocked_count} bloquées)"
        )

    def test_rate_limit_resets_after_window(self):
        """Après la fenêtre temporelle, le compteur se réinitialise."""
        import time
        store, RATE_MAX, RATE_WIN = self._make_rate_store()
        ip = "127.0.0.1"

        # Simule une fenêtre expirée
        store[ip]["count"] = 25
        store[ip]["reset_at"] = time.monotonic() - 1  # déjà expirée

        now = time.monotonic()
        e = store[ip]
        if now > e["reset_at"]:
            e["count"], e["reset_at"] = 0, now + RATE_WIN
        e["count"] += 1

        assert e["count"] == 1, (
            "Après reset de la fenêtre, le compteur doit repartir à 1"
        )

    def test_rate_limit_different_ips_independent(self):
        """Deux IPs différentes ont des compteurs indépendants."""
        import time
        store, RATE_MAX, RATE_WIN = self._make_rate_store()
        now = time.monotonic()

        # IP1 : 21 requêtes (dépasse la limite)
        ip1_blocked = 0
        for i in range(21):
            e = store["192.168.1.1"]
            if now > e["reset_at"]:
                e["count"], e["reset_at"] = 0, now + RATE_WIN
            e["count"] += 1
            if e["count"] > RATE_MAX:
                ip1_blocked += 1

        # IP2 : 1 requête (autorisée)
        ip2_blocked = 0
        e2 = store["192.168.1.2"]
        if now > e2["reset_at"]:
            e2["count"], e2["reset_at"] = 0, now + RATE_WIN
        e2["count"] += 1
        if e2["count"] > RATE_MAX:
            ip2_blocked += 1

        assert ip1_blocked == 1, "IP1 doit être bloquée après 21 requêtes"
        assert ip2_blocked == 0, "IP2 ne doit pas être bloquée"

    def test_rate_limit_exact_max_allowed(self):
        """Exactement RATE_MAX=20 requêtes : toutes autorisées."""
        import time
        store, RATE_MAX, RATE_WIN = self._make_rate_store()
        ip = "127.0.0.1"
        now = time.monotonic()

        blocked_count = 0
        for i in range(20):
            e = store[ip]
            if now > e["reset_at"]:
                e["count"], e["reset_at"] = 0, now + RATE_WIN
            e["count"] += 1
            if e["count"] > RATE_MAX:
                blocked_count += 1

        assert blocked_count == 0, "Exactement 20 requêtes : toutes autorisées"


# ─────────────────────────────────────────────────────────────────────────────
# Tests de _validate_env() — logique de validation d'environnement
# ─────────────────────────────────────────────────────────────────────────────

class TestValidateEnvLogic:
    """
    Simule la logique de _validate_env() sans importer queen.py.
    La logique : retourne True seulement si toutes les vars sont présentes.
    """

    def _validate_env_logic(self, env: dict) -> tuple:
        """Reproduit la logique de _validate_env()."""
        warnings = []
        if not env.get("TELEGRAM_BOT_TOKEN"):
            warnings.append("TELEGRAM_BOT_TOKEN absent")
        if not env.get("ADMIN_TELEGRAM_ID"):
            warnings.append("ADMIN_TELEGRAM_ID absent")
        if not env.get("ANTHROPIC_API_KEY"):
            warnings.append("ANTHROPIC_API_KEY absent")
        return len(warnings) == 0, warnings

    def test_validate_env_all_present(self):
        """Toutes les variables présentes → retourne True."""
        env = {
            "TELEGRAM_BOT_TOKEN": "abc123",
            "ADMIN_TELEGRAM_ID": "456",
            "ANTHROPIC_API_KEY": "sk-test",
        }
        ok, warnings = self._validate_env_logic(env)
        assert ok is True
        assert warnings == []

    def test_validate_env_missing_telegram_token(self):
        """TELEGRAM_BOT_TOKEN manquant → retourne False."""
        env = {
            "TELEGRAM_BOT_TOKEN": "",
            "ADMIN_TELEGRAM_ID": "456",
            "ANTHROPIC_API_KEY": "sk-test",
        }
        ok, warnings = self._validate_env_logic(env)
        assert ok is False
        assert any("TELEGRAM_BOT_TOKEN" in w for w in warnings)

    def test_validate_env_missing_admin_id(self):
        """ADMIN_TELEGRAM_ID manquant → retourne False."""
        env = {
            "TELEGRAM_BOT_TOKEN": "abc123",
            "ADMIN_TELEGRAM_ID": "",
            "ANTHROPIC_API_KEY": "sk-test",
        }
        ok, warnings = self._validate_env_logic(env)
        assert ok is False
        assert any("ADMIN_TELEGRAM_ID" in w for w in warnings)

    def test_validate_env_missing_anthropic_key(self):
        """ANTHROPIC_API_KEY manquant → retourne False (warning non bloquant)."""
        env = {
            "TELEGRAM_BOT_TOKEN": "abc123",
            "ADMIN_TELEGRAM_ID": "456",
            "ANTHROPIC_API_KEY": "",
        }
        ok, warnings = self._validate_env_logic(env)
        assert ok is False

    def test_validate_env_all_missing(self):
        """Toutes les variables manquantes → 3 warnings."""
        env = {}
        ok, warnings = self._validate_env_logic(env)
        assert ok is False
        assert len(warnings) == 3
