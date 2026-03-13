"""
Couche exécution — port 8004
PyAutoGUI · shell sandboxé · verify-after-act · rollback
"""
import subprocess
import os
import json
import asyncio
import httpx
import unicodedata
import re
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import pyautogui
import yaml
from dotenv import load_dotenv
load_dotenv()

ROOT = Path(__file__).resolve().parent.parent

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Executor", version="1.0.0")

BLOCKED_RAW = CONFIG["security"]["blocked_shell_patterns"]
SHELL_TIMEOUT = min(int(CONFIG["security"]["max_shell_timeout"]), 30)
REQUIRE_CONFIRM = CONFIG["security"]["require_confirmation_for"]

# Patterns regex compilés — plus robustes que le substring matching
_BLOCKED_PATTERNS = [
    re.compile(r'rm\s+.*-.*r.*\s+/', re.IGNORECASE),            # rm + tout flag contenant r + path absolu (FIX 1)
    re.compile(r'rm\s+--recursive', re.IGNORECASE),              # rm --recursive (FIX 1)
    re.compile(r':\s*\(\s*\)\s*\{.*\|.*\}', re.DOTALL),         # fork bomb
    re.compile(r'dd\s+if=/dev/zero', re.IGNORECASE),
    re.compile(r'\bmkfs\b', re.IGNORECASE),
    re.compile(r'\b(shutdown|reboot|poweroff|halt)\b', re.IGNORECASE),
    re.compile(r'chmod\s+[0-7]*7[0-7]*\s+/etc', re.IGNORECASE),  # chmod sur /etc (FIX 3)
    re.compile(r'>\s*/etc/passwd', re.IGNORECASE),                # overwrite passwd (FIX 3)
    re.compile(r'>\s*/etc/shadow', re.IGNORECASE),                # overwrite shadow (FIX 3)
    re.compile(r'curl.*\|\s*(bash|sh|zsh)', re.IGNORECASE),       # curl pipe to shell (FIX 3)
    re.compile(r'wget.*-O.*\|\s*(bash|sh|zsh)', re.IGNORECASE),   # wget pipe to shell (FIX 3)
]
OUTPUT_MAX_CHARS = 10_000   # troncature sortie commande

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3

# Thread pool dédié aux appels PyAutoGUI (bloquants — à ne pas exécuter dans l'event loop)
_gui_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pyautogui")
_gui_lock = asyncio.Lock()  # sérialise les appels GUI pour éviter les race conditions


def _type_text_safe(text: str, interval: float = 0.05):
    """Frappe du texte en gérant les accents via clipboard."""
    try:
        import pyperclip
        pyperclip.copy(text)
        import pyautogui
        pyautogui.hotkey('command', 'v')  # macOS
    except ImportError:
        import pyautogui
        # Fallback: typewrite pour les ASCII simples uniquement
        safe_text = ''.join(c for c in text if ord(c) < 128)
        pyautogui.typewrite(safe_text, interval=interval)


async def _gui(fn, *args, **kwargs):
    """Sérialise les appels PyAutoGUI : asyncio.Lock + thread dédié."""
    async with _gui_lock:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(_gui_executor, lambda: fn(*args, **kwargs))


# ─── Sécurité shell ────────────────────────────────────────────────────────────

CMD_MAX_LEN = 2000   # longueur max d'une commande shell — prévient les injections géantes


def is_blocked(cmd: str) -> bool:
    """Vérifie si la commande contient un pattern dangereux.
    Double couche : regex normalisée + tokenisation shlex pour résister aux variantes.
    """
    import shlex
    if len(cmd) > CMD_MAX_LEN:
        return True   # commande anormalement longue — bloquée par précaution
    normalized = ' '.join(cmd.split())   # normalise espaces multiples et tabs

    # Couche 1 : regex sur la chaîne normalisée
    if any(p.search(normalized) for p in _BLOCKED_PATTERNS):
        return True

    # Couche 2 : tokenisation shlex — détecte les variantes d'encodage et de quoting
    try:
        tokens = shlex.split(normalized, posix=True)
        joined = ' '.join(tokens)
        if any(p.search(joined) for p in _BLOCKED_PATTERNS):
            return True
        # Vérification sémantique des tokens dangereux
        if tokens:
            base_cmd = tokens[0].split('/')[-1]   # nom de commande sans chemin absolu
            _DANGEROUS_CMDS = {'shutdown', 'reboot', 'poweroff', 'halt', 'mkfs', 'dd'}
            if base_cmd in _DANGEROUS_CMDS:
                return True
            # rm avec path absolu système — bloque rm -rf /tmp aussi (prudence)
            if base_cmd == 'rm' and len(tokens) > 1:
                flags = [t for t in tokens if t.startswith('-')]
                paths = [t for t in tokens if not t.startswith('-') and t != 'rm']
                has_r = any(
                    'r' in f.lstrip('-').lower() or f in ('--recursive', '--force')
                    for f in flags
                )  # FIX 1 — couvre --recursive et --force en long flags
                is_sys_path = any(
                    p.startswith('/') and any(p.startswith(sp) for sp in ('/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/System', '/Library'))
                    for p in paths
                )
                if has_r and is_sys_path:
                    return True
    except ValueError:
        # shlex.split() échoue sur les quotes non fermées — on bloque par prudence
        return True
    return False


_SAFE_COMMANDS = frozenset([
    'curl', 'wget', 'ls', 'cat', 'grep', 'ps', 'df', 'du',
    'echo', 'pwd', 'which', 'find', 'head', 'tail', 'wc',
    'node', 'python3', 'python', 'npm', 'pip3', 'pip', 'git', 'make',
    'lsof', 'netstat', 'top', 'htop', 'iostat', 'uname', 'env', 'printenv',
    'date', 'uptime', 'id', 'whoami', 'hostname', 'nslookup', 'dig', 'ping',
])

# Patterns regex précis — évite les faux positifs par substring (ex: "delete" dans curl -X DELETE)
_CONFIRM_PATTERNS_RE = [
    re.compile(r'\bdelete\b', re.IGNORECASE),            # mot entier "delete"
    re.compile(r'\bdrop\s+table\b', re.IGNORECASE),
    re.compile(r'\btruncate\s+table\b', re.IGNORECASE),
    re.compile(r'\bkill\s+-9\b', re.IGNORECASE),         # kill -9 spécifiquement
    re.compile(r'\bkillall\b', re.IGNORECASE),
    re.compile(r'\bshutdown\b', re.IGNORECASE),           # shutdown (arrêt système)
    re.compile(r'\bformat\b', re.IGNORECASE),             # format (formatage disque)
    re.compile(r'\bsudo\b', re.IGNORECASE),               # sudo toujours confirmé
    re.compile(r'\bsu\s+-', re.IGNORECASE),               # su - (changement vers root)
]


def needs_confirm(cmd: str) -> bool:
    # Vérifie si la commande nécessite une confirmation humaine (HITL).
    # Deux couches :
    # 1. Whitelist _SAFE_COMMANDS : si le premier token est une commande sure connue → False
    # 2. Regex _CONFIRM_PATTERNS_RE sur le reste : mots entiers, pas substrings
    # Cas corrects : curl -X DELETE → False (whitelist) · kill -9 → True · sudo rm → True
    if not cmd.strip():
        return False
    first_token = cmd.strip().split()[0].lower().lstrip('./')
    if first_token in _SAFE_COMMANDS:
        return False
    for pattern in _CONFIRM_PATTERNS_RE:
        if pattern.search(cmd):
            return True
    return False


# ─── Vérification post-action ──────────────────────────────────────────────────

async def verify_action(description: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"http://localhost:{CONFIG['ports']['perception']}/screenshot")
            screenshot = r.json()
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"http://localhost:{CONFIG['ports']['brain']}/raw",
                json={
                    "role": "worker",
                    "prompt": (
                        f"Confirme visuellement que cette action a réussi: {description}. "
                        "Réponds JSON: {\"success\": true/false, \"confidence\": 0.0-1.0, \"observation\": \"string\"}"
                    ),
                    "system": "Tu analyses des actions effectuées sur macOS. Réponds uniquement en JSON."
                })
            verification = r.json()
        return {"screenshot": screenshot, "verification": verification}
    except Exception as e:
        return {"error": str(e)}


# ─── Modèles Pydantic ──────────────────────────────────────────────────────────

class ClickRequest(BaseModel):
    x: int
    y: int
    button: str = "left"
    description: Optional[str] = None


class TypeRequest(BaseModel):
    text: str
    interval: float = 0.05


class ShellRequest(BaseModel):
    command: str
    cwd: Optional[str] = None
    require_hitl: bool = False


class MoveRequest(BaseModel):
    x: int
    y: int
    duration: float = 0.3


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/click")
async def click(req: ClickRequest):
    try:
        await _gui(pyautogui.click, req.x, req.y, button=req.button)
        await asyncio.sleep(0.5)
        verification = await verify_action(req.description or f"clic en ({req.x},{req.y})")
        return {"clicked": True, "coords": [req.x, req.y], "verification": verification}
    except pyautogui.FailSafeException:
        raise HTTPException(status_code=400, detail="FailSafe PyAutoGUI — souris en coin supérieur gauche")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur clic: {e}")


@app.post("/type")
async def type_text(req: TypeRequest):
    try:
        # pyautogui.typewrite() ne supporte pas les accents/unicode
        # _type_text_safe utilise pyperclip + paste pour les textes non-ASCII
        await _gui(_type_text_safe, req.text, req.interval)
        return {"typed": True, "length": len(req.text)}
    except pyautogui.FailSafeException:
        raise HTTPException(status_code=400, detail="FailSafe PyAutoGUI déclenché")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur frappe: {e}")


@app.post("/move")
async def move(req: MoveRequest):
    try:
        await _gui(pyautogui.moveTo, req.x, req.y, duration=req.duration)
        return {"moved": True, "coords": [req.x, req.y]}
    except pyautogui.FailSafeException:
        raise HTTPException(status_code=400, detail="FailSafe PyAutoGUI déclenché")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur déplacement: {e}")


@app.post("/screenshot")
async def screenshot(region: Optional[str] = None):
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"http://localhost:{CONFIG['ports']['perception']}/screenshot",
            params={"region": region} if region else {}
        )
        return r.json()


@app.post("/shell")
async def shell(req: ShellRequest):
    """
    Exécute une commande shell dans un sandbox sécurisé.
    - Vérifie les patterns bloqués avant toute exécution
    - Timeout forcé à max 30s
    - Sortie tronquée à 10 000 caractères
    - Retourne { stdout, stderr, returncode, blocked }
    """
    # 0. Limite longueur commande
    if len(req.command) > CMD_MAX_LEN:
        return {
            "stdout": "",
            "stderr": f"Commande trop longue ({len(req.command)} chars > {CMD_MAX_LEN}) — refusée",
            "returncode": -1,
            "blocked": True,
            "command": req.command[:200] + "...",
        }

    # 1. Vérification patterns bloqués
    if is_blocked(req.command):
        print(f"[Executor] Commande bloquée — CMD: {req.command[:200]}")  # FIX 4
        return {
            "stdout": "",
            "stderr": f"Commande bloquée par sandbox: {req.command}",
            "returncode": -1,
            "blocked": True,
            "command": req.command,
        }

    # 2. Vérification nécessité de confirmation humaine (HITL)
    if needs_confirm(req.command) or req.require_hitl:
        return {
            "stdout": "",
            "stderr": "",
            "returncode": -1,
            "blocked": False,
            "status": "hitl_required",
            "command": req.command,
            "message": "Validation humaine requise — envoi Telegram HITL",
        }

    # FIX 2 — Validation cwd : restreint aux chemins sous HOME ou ROOT projet
    if req.cwd:
        cwd_path = Path(req.cwd).resolve()
        allowed_roots = [Path.home(), ROOT]
        if not any(str(cwd_path).startswith(str(r)) for r in allowed_roots):
            return {
                "stdout": "", "stderr": f"cwd non autorisé: {req.cwd}",
                "returncode": -1, "blocked": True, "command": req.command
            }
        cwd = str(cwd_path)
    else:
        cwd = str(ROOT)

    # 3. Exécution avec timeout forcé ≤ 30s
    try:
        result = subprocess.run(
            req.command, shell=True, capture_output=True, text=True,
            timeout=SHELL_TIMEOUT, cwd=cwd
        )
        # 4. Troncature sortie à OUTPUT_MAX_CHARS
        stdout = result.stdout[:OUTPUT_MAX_CHARS]
        stderr = result.stderr[:OUTPUT_MAX_CHARS]

        # Log explicite si la commande échoue (facilite le debug)
        if result.returncode != 0:
            print(f"[Executor] ⚠️ Commande échouée (rc={result.returncode})")
            print(f"[Executor]   CMD    : {req.command[:200]}")
            print(f"[Executor]   STDOUT : {stdout[:300] or '(vide)'}")
            print(f"[Executor]   STDERR : {stderr[:300] or '(vide)'}")

        return {
            "stdout": stdout,
            "stderr": stderr,
            "returncode": result.returncode,
            "blocked": False,
            "command": req.command,
            "truncated": len(result.stdout) > OUTPUT_MAX_CHARS or len(result.stderr) > OUTPUT_MAX_CHARS,
        }
    except subprocess.TimeoutExpired:
        print(f"[Executor] ⏱️ Timeout ({SHELL_TIMEOUT}s) — CMD: {req.command[:200]}")
        return {
            "stdout": "",
            "stderr": f"Timeout: commande dépassé {SHELL_TIMEOUT}s",
            "returncode": -1,
            "blocked": False,
            "command": req.command,
        }
    except Exception as e:
        print(f"[Executor] ❌ Exception inattendue — CMD: {req.command[:200]} — ERR: {e}")
        return {
            "stdout": "",
            "stderr": str(e)[:OUTPUT_MAX_CHARS],
            "returncode": -1,
            "blocked": False,
            "command": req.command,
        }


@app.post("/hotkey")
async def hotkey(keys: dict):
    try:
        key_combo = keys.get("keys", [])
        if not key_combo:
            raise HTTPException(status_code=422, detail="Champ 'keys' requis")
        await _gui(pyautogui.hotkey, *key_combo)
        return {"pressed": key_combo}
    except pyautogui.FailSafeException:
        raise HTTPException(status_code=400, detail="FailSafe PyAutoGUI déclenché")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur hotkey: {e}")


@app.post("/scroll")
async def scroll(data: dict):
    try:
        await _gui(pyautogui.scroll, data.get("clicks", 3), x=data.get("x"), y=data.get("y"))
        return {"scrolled": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erreur scroll: {e}")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "layer": "executor",
        "failsafe": pyautogui.FAILSAFE,
        "shell_timeout": SHELL_TIMEOUT,
        "blocked_patterns": len(_BLOCKED_PATTERNS),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["executor"])
