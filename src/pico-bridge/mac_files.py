"""
skills/mac_files.py — Opérations fichiers macOS

Créer, lire, modifier, ouvrir des fichiers.
Utilise Python natif + AppleScript pour l'UI Finder.
"""

import asyncio
import os
import subprocess
from pathlib import Path


async def create_file(path: str, content: str = "") -> dict:
    """Crée un fichier avec contenu optionnel."""
    try:
        p = Path(path).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.rename(p)
        return {"success": True, "path": str(p)}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def read_file(path: str, max_chars: int = 5000) -> dict:
    """Lit le contenu d'un fichier."""
    try:
        p = Path(path).expanduser()
        if not p.exists():
            return {"success": False, "error": f"Fichier non trouvé: {path}"}
        content = p.read_text(encoding="utf-8", errors="replace")
        return {
            "success": True,
            "content": content[:max_chars],
            "truncated": len(content) > max_chars,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def open_in_finder(path: str) -> dict:
    """Ouvre un chemin dans le Finder."""
    try:
        subprocess.run(["open", Path(path).expanduser()], check=True)
        return {"success": True, "path": path}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def open_file(path: str) -> dict:
    """Ouvre un fichier avec l'application par défaut."""
    try:
        subprocess.run(["open", Path(path).expanduser()], check=True)
        await asyncio.sleep(1.5)
        return {"success": True, "path": path}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def list_dir(path: str = "~", pattern: str = "*") -> dict:
    """Liste les fichiers d'un dossier."""
    try:
        p = Path(path).expanduser()
        files = sorted(p.glob(pattern))[:50]
        return {
            "success": True,
            "path":  str(p),
            "files": [str(f.name) for f in files],
            "count": len(files),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def run_script(script_path: str) -> dict:
    """Exécute un script shell ou Python."""
    try:
        p = Path(script_path).expanduser()
        if not p.exists():
            return {"success": False, "error": "Script non trouvé"}
        result = subprocess.run(
            ["python3", str(p)] if p.suffix == ".py" else ["bash", str(p)],
            capture_output=True, text=True, timeout=30
        )
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout[:2000],
            "stderr": result.stderr[:500],
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def create_desktop_file(name: str, content: str) -> dict:
    """Crée un fichier sur le Bureau."""
    desktop = Path.home() / "Desktop" / name
    return await create_file(str(desktop), content)
