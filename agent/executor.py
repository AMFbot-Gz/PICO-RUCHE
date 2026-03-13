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
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import pyautogui
import yaml

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Executor", version="1.0.0")

BLOCKED = CONFIG["security"]["blocked_shell_patterns"]
SHELL_TIMEOUT = CONFIG["security"]["max_shell_timeout"]
REQUIRE_CONFIRM = CONFIG["security"]["require_confirmation_for"]
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3


def is_blocked(cmd: str) -> bool:
    return any(p in cmd for p in BLOCKED)


def needs_confirm(cmd: str) -> bool:
    return any(k in cmd.lower() for k in REQUIRE_CONFIRM)


async def verify_action(description: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.post(f"http://localhost:{CONFIG['ports']['perception']}/screenshot")
            screenshot = r.json()
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"http://localhost:{CONFIG['ports']['brain']}/raw",
                json={
                    "role": "worker",
                    "prompt": f"Confirme visuellement que cette action a réussi: {description}. Réponds JSON: {{\"success\": true/false, \"confidence\": 0.0-1.0, \"observation\": \"string\"}}",
                    "system": "Tu analyses des actions effectuées sur macOS. Réponds uniquement en JSON."
                })
            verification = r.json()
        return {"screenshot": screenshot, "verification": verification}
    except Exception as e:
        return {"error": str(e)}


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


@app.post("/click")
async def click(req: ClickRequest):
    pyautogui.click(req.x, req.y, button=req.button)
    await asyncio.sleep(0.5)
    verification = await verify_action(req.description or f"clic en ({req.x},{req.y})")
    return {"clicked": True, "coords": [req.x, req.y], "verification": verification}


@app.post("/type")
async def type_text(req: TypeRequest):
    pyautogui.typewrite(req.text, interval=req.interval)
    return {"typed": True, "length": len(req.text)}


@app.post("/move")
async def move(req: MoveRequest):
    pyautogui.moveTo(req.x, req.y, duration=req.duration)
    return {"moved": True, "coords": [req.x, req.y]}


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
    if is_blocked(req.command):
        raise HTTPException(status_code=403, detail=f"Commande bloquée par sandbox: {req.command}")
    if needs_confirm(req.command) or req.require_hitl:
        return {
            "status": "hitl_required",
            "command": req.command,
            "message": "Validation humaine requise — envoi Telegram"
        }
    cwd = req.cwd or os.path.expanduser("~/Desktop/PICO-RUCHE")
    try:
        result = subprocess.run(
            req.command, shell=True, capture_output=True, text=True,
            timeout=SHELL_TIMEOUT, cwd=cwd
        )
        return {
            "stdout": result.stdout[-3000:],
            "stderr": result.stderr[-1000:],
            "returncode": result.returncode,
            "command": req.command
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=408, detail=f"Timeout {SHELL_TIMEOUT}s dépassé")


@app.post("/hotkey")
async def hotkey(keys: dict):
    key_combo = keys.get("keys", [])
    pyautogui.hotkey(*key_combo)
    return {"pressed": key_combo}


@app.post("/scroll")
async def scroll(data: dict):
    pyautogui.scroll(data.get("clicks", 3), x=data.get("x"), y=data.get("y"))
    return {"scrolled": True}


@app.get("/health")
async def health():
    return {"status": "ok", "layer": "executor", "failsafe": pyautogui.FAILSAFE}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["executor"])
