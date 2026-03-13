"""
Skill : git_ops — Opérations Git sécurisées pour PICO-RUCHE
Sandbox strict : seul ~/Desktop/PICO-RUCHE est autorisé.
Liste blanche de commandes : status, log, diff.
"""
import subprocess
from pathlib import Path
from typing import Any

# Chemin autorisé — sandbox strict
ALLOWED_ROOT = Path.home() / "Desktop" / "PICO-RUCHE"

# Liste blanche : chaque entrée est la commande exacte (args séparés)
_ALLOWED_COMMANDS: list[list[str]] = [
    ["git", "status"],
    ["git", "log", "--oneline", "-10"],
    ["git", "diff", "--stat"],
]

# Index rapide pour validation
_ALLOWED_SET: set[tuple[str, ...]] = {tuple(cmd) for cmd in _ALLOWED_COMMANDS}


def _run(args: list[str]) -> dict[str, Any]:
    """
    Exécute une commande git dans ALLOWED_ROOT.
    Retourne {"success": bool, "stdout": str, "stderr": str}.
    """
    key = tuple(args)
    if key not in _ALLOWED_SET:
        return {
            "success": False,
            "stdout": "",
            "stderr": f"Commande non autorisée : {' '.join(args)}",
        }

    try:
        proc = subprocess.run(
            args,
            cwd=str(ALLOWED_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        return {
            "success": proc.returncode == 0,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "stdout": "", "stderr": "Timeout (15 s)"}
    except Exception as exc:
        return {"success": False, "stdout": "", "stderr": str(exc)}


def status() -> dict[str, Any]:
    """Retourne git status de PICO-RUCHE."""
    result = _run(["git", "status"])
    return {"command": "git status", **result}


def log() -> dict[str, Any]:
    """Retourne les 10 derniers commits (--oneline)."""
    result = _run(["git", "log", "--oneline", "-10"])
    lines = result["stdout"].splitlines() if result["success"] else []
    return {
        "command": "git log --oneline -10",
        "commits": lines,
        **result,
    }


def diff_stat() -> dict[str, Any]:
    """Retourne le résumé des fichiers modifiés (--stat)."""
    result = _run(["git", "diff", "--stat"])
    return {"command": "git diff --stat", **result}


def all_ops() -> dict[str, Any]:
    """Exécute les trois opérations et retourne un rapport consolidé."""
    return {
        "status":   status(),
        "log":      log(),
        "diff_stat": diff_stat(),
    }


if __name__ == "__main__":
    import json
    print(json.dumps(all_ops(), indent=2))
