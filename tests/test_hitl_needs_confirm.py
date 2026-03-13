"""
tests/test_hitl_needs_confirm.py — Tests needs_confirm() après fix faux positifs

Vérifie que :
  - curl, ls, ps, npm, python3, git → False (jamais de HITL)
  - kill -9, sudo rm, drop table   → True  (HITL requis)
  - curl -X DELETE http://...      → False (DELETE = flag HTTP, pas commande shell)
"""
import sys
import re
from pathlib import Path

# Importer directement depuis agent/executor.py
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from agent.executor import needs_confirm


class TestNeedsConfirmSafeCommands:
    """Commandes de diagnostic — ne doivent jamais déclencher HITL."""

    def test_curl_get(self):
        assert needs_confirm("curl http://localhost:8001/status") is False

    def test_curl_post(self):
        assert needs_confirm("curl -X POST http://localhost:8001/mission -d '{}'") is False

    def test_curl_delete_http_method(self):
        """curl -X DELETE est un verbe HTTP, pas une commande shell delete."""
        assert needs_confirm("curl -X DELETE http://localhost:3000/api/goals/abc") is False

    def test_curl_json(self):
        assert needs_confirm(
            'curl -s -X POST http://localhost:8001/mission '
            '-H "Content-Type: application/json" -d \'{"command": "ls"}\''
        ) is False

    def test_ls(self):
        assert needs_confirm("ls -la /tmp") is False

    def test_ls_grep(self):
        assert needs_confirm("ls /var | grep log") is False

    def test_cat(self):
        assert needs_confirm("cat /etc/hosts") is False

    def test_grep(self):
        assert needs_confirm("grep -rn 'error' agent/logs/") is False

    def test_ps(self):
        assert needs_confirm("ps aux | grep python") is False

    def test_df(self):
        assert needs_confirm("df -h") is False

    def test_npm(self):
        assert needs_confirm("npm test") is False

    def test_python3(self):
        assert needs_confirm("python3 scripts/status_agent.py") is False

    def test_git_status(self):
        assert needs_confirm("git status") is False

    def test_git_log(self):
        assert needs_confirm("git log --oneline -10") is False

    def test_echo(self):
        assert needs_confirm("echo 'hello world'") is False

    def test_which(self):
        assert needs_confirm("which python3") is False

    def test_find(self):
        assert needs_confirm("find /tmp -name '*.log' -mtime +7") is False

    def test_lsof(self):
        assert needs_confirm("lsof -i :8001") is False

    def test_uname(self):
        assert needs_confirm("uname -a") is False


class TestNeedsConfirmDangerousCommands:
    """Commandes dangereuses — doivent toujours déclencher HITL."""

    def test_kill_9(self):
        assert needs_confirm("kill -9 1234") is True

    def test_killall(self):
        assert needs_confirm("killall python3") is True

    def test_sudo_rm(self):
        assert needs_confirm("sudo rm -rf /var") is True

    def test_sudo_any(self):
        assert needs_confirm("sudo chmod 777 /etc/passwd") is True

    def test_drop_table(self):
        assert needs_confirm("drop table users") is True

    def test_truncate_table(self):
        assert needs_confirm("truncate table logs") is True

    def test_delete_word(self):
        """La commande 'delete' seule (pas curl -X DELETE)."""
        assert needs_confirm("delete /var/important.db") is True

    def test_su_root(self):
        assert needs_confirm("su - root") is True


class TestNeedsConfirmEdgeCases:
    """Cas limites."""

    def test_empty_command(self):
        assert needs_confirm("") is False

    def test_whitespace_only(self):
        assert needs_confirm("   ") is False

    def test_sudo_ls_still_needs_confirm(self):
        """sudo toujours confirmé, même pour lecture seule — sécurité stricte."""
        assert needs_confirm("sudo ls /root") is True

    def test_kill_without_9(self):
        """kill sans -9 = signal TERM — jugé acceptable sans HITL."""
        assert needs_confirm("kill 1234") is False

    def test_python3_delete_arg(self):
        """python3 avec argument 'delete' — premier token python3 → safe."""
        assert needs_confirm("python3 manage.py delete_old_logs") is False
