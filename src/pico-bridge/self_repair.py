"""
actions/self_repair.py — Auto-réparation via Claude Code CLI

La classe SelfRepair génère un rapport de crash et tente de corriger
automatiquement le module fautif en appelant `claude -p`.

Le décorateur @watch_and_repair encapsule n'importe quelle fonction
et déclenche la réparation automatique si elle lève une exception.
"""

import functools
import subprocess
import traceback as tb_module
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
CRASH_DIR = BASE_DIR / "memory" / "crash_reports"


# ─── Classe SelfRepair ───────────────────────────────────────────────────────

class SelfRepair:
    """Génère des rapports de crash et tente l'auto-réparation via Claude Code."""

    # ─── 1. __init__ ─────────────────────────────────────────────────────────

    def __init__(self):
        CRASH_DIR.mkdir(parents=True, exist_ok=True)

    # ─── 2. generate_report ──────────────────────────────────────────────────

    def generate_report(self, module_path: str, error: str, tb: str) -> str:
        """
        Génère un rapport de crash texte dans memory/crash_reports/.
        Inclut le contenu du fichier fautif pour permettre l'analyse.

        Retourne le chemin absolu du rapport créé.
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        report_path = CRASH_DIR / f"crash_{timestamp}.txt"

        # Lecture du fichier source (best-effort)
        file_content = ""
        try:
            file_content = Path(module_path).read_text(encoding="utf-8")
        except Exception as read_err:
            file_content = f"[Impossible de lire le fichier : {read_err}]"

        content = (
            f"MODULE: {module_path}\n"
            f"ERREUR: {error}\n"
            f"TRACEBACK:\n{tb}\n"
            f"CONTENU DU FICHIER:\n{file_content}\n"
        )

        report_path.write_text(content, encoding="utf-8")
        return str(report_path)

    # ─── 3. repair ───────────────────────────────────────────────────────────

    def repair(self, module_path: str, error: str, tb: str) -> bool:
        """
        Génère un rapport puis demande à Claude Code de réparer le module.

        Retourne True si le fichier est toujours accessible après réparation
        (critère de succès minimal — Claude a pu modifier le fichier sans le supprimer).
        """
        report_path = self.generate_report(module_path, error, tb)
        print(f"📋 Rapport de crash : {report_path}")

        prompt = (
            f"Répare {module_path}. "
            f"Erreur: {error}. "
            f"Traceback: {tb}. "
            "Modifie uniquement ce fichier."
        )

        try:
            result = subprocess.run(
                ["claude", "-p", prompt],
                capture_output=True,
                text=True,
                timeout=90,
                cwd=str(BASE_DIR),
            )
            success = result.returncode == 0
            if not success:
                print(f"⚠️  Claude Code stderr : {result.stderr[:300]}")
        except FileNotFoundError:
            print("❌ Claude Code CLI introuvable (npm install -g @anthropic-ai/claude-code)")
            success = False
        except subprocess.TimeoutExpired:
            print("❌ Timeout : Claude Code n'a pas répondu en 90s")
            success = False
        except Exception as e:
            print(f"❌ Erreur subprocess : {e}")
            success = False

        # Vérifie que le fichier est toujours là
        return Path(module_path).exists()


# ─── Décorateur watch_and_repair ─────────────────────────────────────────────

def watch_and_repair(func):
    """
    Décorateur qui surveille une fonction et tente une auto-réparation
    si elle lève une exception.

    Comportement :
    1. Exécute func normalement.
    2. En cas d'exception : génère un rapport + appelle SelfRepair.repair().
    3. Si réparation réussie : retente func() une fois.
    4. Si échec définitif : log l'erreur dans crash_reports/ et retourne None.

    Usage :
        @watch_and_repair
        def ma_fonction():
            ...
    """
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)

        except Exception as exc:
            error_str = str(exc)
            tb_str = tb_module.format_exc()

            # Identifie le fichier source de la fonction décorée
            module_file = _resolve_module_path(func)
            print(f"\n⚠️  Exception dans '{func.__name__}' : {error_str}")
            print(f"🔧 Tentative d'auto-réparation → {module_file}")

            repairer = SelfRepair()
            repaired = repairer.repair(module_file, error_str, tb_str)

            if repaired:
                print(f"✅ Réparation signalée — nouvelle tentative de '{func.__name__}'…")
                try:
                    return func(*args, **kwargs)
                except Exception as retry_exc:
                    final_tb = tb_module.format_exc()
                    print(f"❌ Échec après réparation : {retry_exc}")
                    repairer.generate_report(module_file, str(retry_exc), final_tb)
                    return None
            else:
                print(f"❌ Réparation échouée pour '{func.__name__}'.")
                return None

    return wrapper


# ─── Helper privé ─────────────────────────────────────────────────────────────

def _resolve_module_path(func) -> str:
    """Retourne le chemin absolu du fichier source d'une fonction."""
    import inspect
    try:
        source_file = inspect.getfile(func)
        return str(Path(source_file).resolve())
    except (TypeError, OSError):
        return f"<module inconnu : {func.__module__}.{func.__qualname__}>"
