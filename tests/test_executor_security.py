"""
Tests de sécurité pour agent/executor.py.

Teste is_blocked() et needs_confirm() en isolation complète :
- Les patterns regex compilés dans executor.py (pas le YAML — les patterns regex)
- needs_confirm() utilise REQUIRE_CONFIRM depuis le YAML mocké
"""
import pytest
import sys
import os
import re
import unittest.mock as mock

# Mock des dépendances système avant tout import
sys.modules.setdefault('pyautogui', mock.MagicMock())
sys.modules.setdefault('pyperclip', mock.MagicMock())

# Config YAML mockée alignée avec agent_config.yml réel
MOCK_CONFIG = {
    "security": {
        "blocked_shell_patterns": [
            "rm -rf /",
            ":(){ :|:& };:",
            "dd if=/dev/zero",
            "mkfs",
            "shutdown",
            "reboot",
        ],
        "max_shell_timeout": 30,
        "require_confirmation_for": ["delete", "format", "kill", "shutdown"],
        "hitl_mode": "relay",
    },
    "ports": {
        "queen": 8001,
        "perception": 8002,
        "brain": 8003,
        "executor": 8004,
        "evolution": 8005,
        "memory": 8006,
        "mcp_bridge": 8007,
    },
    "ollama": {
        "base_url": "http://localhost:11434",
        "models": {"strategist": "llama3:latest", "worker": "llama3.2:3b"},
    },
    "mlx": {"enabled": False, "server_url": "http://127.0.0.1:8080/v1"},
    "brain": {
        "max_context_tokens": 8000,
        "compress_threshold": 6000,
        "max_subtasks": 5,
        "risk_levels": ["low", "medium", "high"],
    },
    "memory": {
        "max_episodes": 500,
        "episode_file": "agent/memory/episodes.jsonl",
        "persistent_file": "agent/memory/persistent.md",
        "world_state_file": "agent/memory/world_state.json",
    },
    "perception": {"interval_seconds": 30},
    "telegram": {"hitl_timeout_seconds": 120},
}

# Chemin racine du projet (deux niveaux au-dessus de tests/)
_ROOT = os.path.join(os.path.dirname(__file__), '..')
_AGENT_CONFIG = os.path.join(_ROOT, 'agent_config.yml')

EXECUTOR_AVAILABLE = False
is_blocked = None
needs_confirm = None

try:
    _mock_open = mock.mock_open(read_data="")
    with mock.patch('builtins.open', _mock_open), \
         mock.patch('yaml.safe_load', return_value=MOCK_CONFIG):
        # Force reload pour éviter les artefacts de cache
        if 'executor' in sys.modules:
            del sys.modules['executor']
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'agent'))
        import executor as _executor_mod
        is_blocked = _executor_mod.is_blocked
        needs_confirm = _executor_mod.needs_confirm
        EXECUTOR_AVAILABLE = True
except Exception as _import_err:
    print(f"[test] executor non importable: {_import_err}")


# ─────────────────────────────────────────────────────────────────────────────
# Tests is_blocked() — patterns regex compilés dans executor.py
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not EXECUTOR_AVAILABLE, reason="executor non importable")
class TestIsBlocked:
    """
    Teste les patterns regex compilés dans _BLOCKED_PATTERNS :
      - rm\\s+-[a-z]*r[a-z]*f?\\s+/  → rm -rf / et variantes
      - fork bomb pattern
      - dd if=/dev/zero
      - \\bmkfs\\b
      - \\b(shutdown|reboot|poweroff|halt)\\b
    """

    # --- Commandes qui DOIVENT être bloquées ---

    def test_rm_rf_slash_blocked(self):
        """rm -rf / doit être bloqué."""
        assert is_blocked("rm -rf /") is True

    def test_rm_rf_path_blocked(self):
        """rm -rf /home/user doit être bloqué (variante avec path)."""
        assert is_blocked("rm -rf /home/user") is True

    def test_rm_rf_double_space_blocked(self):
        """rm  -rf / avec double espace doit être bloqué (normalisation)."""
        assert is_blocked("rm  -rf /") is True

    def test_rm_rf_variant_fr_blocked(self):
        """rm -fr / (ordre inversé des flags) doit être bloqué."""
        assert is_blocked("rm -fr /") is True

    def test_shutdown_blocked(self):
        """shutdown doit être bloqué."""
        assert is_blocked("shutdown now") is True

    def test_shutdown_h_blocked(self):
        """shutdown -h now doit être bloqué."""
        assert is_blocked("shutdown -h now") is True

    def test_reboot_blocked(self):
        """reboot doit être bloqué."""
        assert is_blocked("reboot") is True

    def test_poweroff_blocked(self):
        """poweroff doit être bloqué."""
        assert is_blocked("poweroff") is True

    def test_halt_blocked(self):
        """halt doit être bloqué."""
        assert is_blocked("halt") is True

    def test_dd_zero_blocked(self):
        """dd if=/dev/zero doit être bloqué."""
        assert is_blocked("dd if=/dev/zero of=/dev/sda") is True

    def test_mkfs_blocked(self):
        """mkfs doit être bloqué."""
        assert is_blocked("mkfs.ext4 /dev/sda") is True

    def test_mkfs_standalone_blocked(self):
        """mkfs seul doit être bloqué."""
        assert is_blocked("mkfs") is True

    # --- Commandes qui NE DOIVENT PAS être bloquées ---

    def test_ls_not_blocked(self):
        """ls -la ne doit pas être bloqué."""
        assert is_blocked("ls -la") is False

    def test_echo_not_blocked(self):
        """echo hello world ne doit pas être bloqué."""
        assert is_blocked("echo hello world") is False

    def test_python_not_blocked(self):
        """python3 script.py ne doit pas être bloqué."""
        assert is_blocked("python3 script.py") is False

    def test_git_not_blocked(self):
        """git status ne doit pas être bloqué."""
        assert is_blocked("git status") is False

    def test_npm_test_not_blocked(self):
        """npm test ne doit pas être bloqué."""
        assert is_blocked("npm test") is False

    def test_curl_health_not_blocked(self):
        """curl vers localhost ne doit pas être bloqué."""
        assert is_blocked("curl http://localhost:3000/health") is False

    def test_rm_file_only_not_blocked(self):
        """rm fichier.txt (sans -rf /) ne doit pas être bloqué."""
        assert is_blocked("rm fichier.txt") is False

    def test_grep_not_blocked(self):
        """grep -r pattern . ne doit pas être bloqué."""
        assert is_blocked("grep -r pattern .") is False

    def test_pytest_not_blocked(self):
        """python3 -m pytest ne doit pas être bloqué."""
        assert is_blocked("python3 -m pytest tests/ -v") is False

    def test_make_not_blocked(self):
        """make build ne doit pas être bloqué."""
        assert is_blocked("make build") is False

    def test_empty_string_not_blocked(self):
        """Chaîne vide ne doit pas être bloquée."""
        assert is_blocked("") is False

    def test_cat_not_blocked(self):
        """cat /etc/hosts ne doit pas être bloqué."""
        assert is_blocked("cat /etc/hosts") is False

    @pytest.mark.parametrize("cmd,expected", [
        ("rm -rf /", True),
        ("rm -rf /home/user", True),
        ("rm  -rf /", True),
        ("shutdown now", True),
        ("reboot", True),
        ("dd if=/dev/zero of=/dev/sda", True),
        ("mkfs.ext4 /dev/sda", True),
        ("ls -la", False),
        ("echo hello world", False),
        ("python3 script.py", False),
        ("git status", False),
        ("npm test", False),
        ("curl http://localhost:3000/health", False),
        ("poweroff", True),
        ("halt", True),
        ("rm fichier.txt", False),
    ])
    def test_is_blocked_parametrize(self, cmd, expected):
        """Test paramétrisé de is_blocked() — toutes les combinaisons."""
        result = is_blocked(cmd)
        assert result == expected, (
            f"is_blocked({cmd!r}) retourné {result}, attendu {expected}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Tests needs_confirm() — mots-clés REQUIRE_CONFIRM
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not EXECUTOR_AVAILABLE, reason="executor non importable")
class TestNeedsConfirm:
    """
    needs_confirm() vérifie si l'un des mots-clés de REQUIRE_CONFIRM
    est présent dans cmd.lower() :
    ["delete", "format", "kill", "shutdown"]
    """

    def test_kill_requires_confirm(self):
        """kill -9 1234 doit nécessiter confirmation."""
        assert needs_confirm("kill -9 1234") is True

    def test_shutdown_requires_confirm(self):
        """shutdown -h now doit nécessiter confirmation."""
        assert needs_confirm("shutdown -h now") is True

    def test_format_requires_confirm(self):
        """format C: doit nécessiter confirmation."""
        assert needs_confirm("format C:") is True

    def test_delete_requires_confirm(self):
        """delete important_file doit nécessiter confirmation."""
        assert needs_confirm("delete important_file") is True

    def test_kill_uppercase_requires_confirm(self):
        """KILL (majuscules) doit nécessiter confirmation (case-insensitive)."""
        assert needs_confirm("KILL -9 1234") is True

    def test_ls_no_confirm(self):
        """ls ne doit pas nécessiter confirmation."""
        assert needs_confirm("ls") is False

    def test_echo_no_confirm(self):
        """echo ne doit pas nécessiter confirmation."""
        assert needs_confirm("echo bonjour") is False

    def test_git_status_no_confirm(self):
        """git status ne doit pas nécessiter confirmation."""
        assert needs_confirm("git status") is False

    def test_rm_file_no_confirm(self):
        """rm fichier.txt seul (sans 'delete') ne doit pas nécessiter confirmation."""
        assert needs_confirm("rm fichier.txt") is False

    def test_python_no_confirm(self):
        """python3 script.py ne doit pas nécessiter confirmation."""
        assert needs_confirm("python3 script.py") is False

    @pytest.mark.parametrize("cmd,expected", [
        ("kill -9 1234", True),
        ("shutdown -h now", True),
        ("format C:", True),
        ("delete important_file", True),
        ("KILL -9 999", True),
        ("ls", False),
        ("echo bonjour", False),
        ("git status", False),
        ("rm fichier.txt", False),
        ("python3 script.py", False),
        ("npm run build", False),
    ])
    def test_needs_confirm_parametrize(self, cmd, expected):
        """Test paramétrisé de needs_confirm()."""
        result = needs_confirm(cmd)
        assert result == expected, (
            f"needs_confirm({cmd!r}) retourné {result}, attendu {expected}"
        )
