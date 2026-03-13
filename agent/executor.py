"""
Couche exécution — port 8004
PyAutoGUI · shell sandboxé · verify-after-act · rollback
"""
import subprocess
import os
import json
import asyncio
import httpx
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

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Executor", version="1.0.0")

BLOCKED = CONFIG["security"]["blocked_shell_patterns"]
SHELL_TIMEOUT = min(int(CONFIG["security"]["max_shell_timeout"]), 30)   # max 30s
REQUIRE_CONFIRM = CONFIG["security"]["require_confirmation_for"]
OUTPUT_MAX_CHARS = 10_000   # troncature sortie commande

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3

# Thread pool dédié aux appels PyAutoGUI (bloquants — à ne pas exécuter dans l'event loop)
_gui_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pyautogui")


async def _gui(fn, *args, **kwargs):
    """Exécute un appel PyAutoGUI dans un thread dédié pour ne pas bloquer l'event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_gui_executor, lambda: fn(*args, **kwargs))


# ─── Sécurité shell ────────────────────────────────────────────────────────────

def is_blocked(cmd: str) -> bool:
    """Vérifie si la commande contient un pattern bloqué par la config de sécurité."""
    return any(p in cmd for p in BLOCKED)


def needs_confirm(cmd: str) -> bool:
    """Vérifie si la commande nécessite une confirmation humaine (HITL)."""
    return any(k in cmd.lower() for k in REQUIRE_CONFIRM)


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
        await _gui(pyautogui.typewrite, req.text, interval=req.interval)
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
    # 1. Vérification patterns bloqués
    if is_blocked(req.command):
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

    cwd = req.cwd or os.path.expanduser("~/Desktop/PICO-RUCHE")

    # 3. Exécution avec timeout forcé ≤ 30s
    try:
        result = subprocess.run(
            req.command, shell=True, capture_output=True, text=True,
            timeout=SHELL_TIMEOUT, cwd=cwd
        )
        # 4. Troncature sortie à OUTPUT_MAX_CHARS
        stdout = result.stdout[:OUTPUT_MAX_CHARS]
        stderr = result.stderr[:OUTPUT_MAX_CHARS]
        return {
            "stdout": stdout,
            "stderr": stderr,
            "returncode": result.returncode,
            "blocked": False,
            "command": req.command,
            "truncated": len(result.stdout) > OUTPUT_MAX_CHARS or len(result.stderr) > OUTPUT_MAX_CHARS,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Timeout: commande dépassé {SHELL_TIMEOUT}s",
            "returncode": -1,
            "blocked": False,
            "command": req.command,
        }
    except Exception as e:
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
        "blocked_patterns": len(BLOCKED),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["executor"])
