"""
Skill : file_search — Recherche et lecture de fichiers dans PICO-RUCHE
Sandbox strict : toutes les opérations restent dans ~/Desktop/PICO-RUCHE.
"""
import os
import fnmatch
from pathlib import Path
from typing import Any

# Répertoire racine autorisé
ALLOWED_ROOT = (Path.home() / "Desktop" / "PICO-RUCHE").resolve()

# Dossiers à ignorer lors du parcours (trop volumineux ou non pertinents)
_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv",
    "venv", "mlx-models", "dist", "build",
}


def _assert_safe(path: Path) -> None:
    """Lève ValueError si le chemin sort du sandbox."""
    resolved = path.resolve()
    try:
        resolved.relative_to(ALLOWED_ROOT)
    except ValueError:
        raise ValueError(f"Accès refusé hors sandbox : {resolved}")


def find_in_project(pattern: str, extension: str = "") -> dict[str, Any]:
    """
    Parcourt l'arborescence PICO-RUCHE et retourne les fichiers correspondants.

    Args:
        pattern   : glob partiel sur le nom de fichier (ex: "skill*", "queen")
        extension : extension sans point (ex: "py", "js", "json").
                    Si vide, toutes extensions acceptées.

    Returns:
        {
            "success": bool,
            "matches": [str, ...],   # chemins absolus
            "count": int
        }
    """
    # Construire le glob complet
    ext_part = f".{extension}" if extension else ""
    full_pattern = f"{pattern}*{ext_part}" if ext_part else pattern

    matches: list[str] = []

    try:
        for dirpath, dirnames, filenames in os.walk(ALLOWED_ROOT):
            # Pruning des dossiers exclus (modification in-place pour os.walk)
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]

            for filename in filenames:
                if fnmatch.fnmatch(filename, full_pattern):
                    matches.append(str(Path(dirpath) / filename))

        return {"success": True, "matches": sorted(matches), "count": len(matches)}

    except Exception as exc:
        return {"success": False, "matches": [], "count": 0, "error": str(exc)}


def read_file_safe(path: str, max_chars: int = 8000) -> dict[str, Any]:
    """
    Lit un fichier uniquement si son chemin reste dans PICO-RUCHE.

    Args:
        path      : chemin absolu ou relatif à PICO-RUCHE
        max_chars : nombre max de caractères retournés (défaut 8000)

    Returns:
        {
            "success": bool,
            "content": str,
            "truncated": bool,
            "path": str
        }
    """
    target = Path(path) if Path(path).is_absolute() else ALLOWED_ROOT / path

    try:
        _assert_safe(target)
    except ValueError as exc:
        return {"success": False, "content": "", "truncated": False,
                "path": str(target), "error": str(exc)}

    if not target.exists():
        return {"success": False, "content": "", "truncated": False,
                "path": str(target), "error": "Fichier introuvable"}

    if not target.is_file():
        return {"success": False, "content": "", "truncated": False,
                "path": str(target), "error": "N'est pas un fichier"}

    try:
        raw = target.read_text(encoding="utf-8", errors="replace")
        truncated = len(raw) > max_chars
        return {
            "success":   True,
            "content":   raw[:max_chars],
            "truncated": truncated,
            "path":      str(target),
        }
    except Exception as exc:
        return {"success": False, "content": "", "truncated": False,
                "path": str(target), "error": str(exc)}


if __name__ == "__main__":
    import json
    print(json.dumps(find_in_project("skill", "py"), indent=2))
