"""
Orchestrateur central — port 8001
Boucle vitale 30s · missions Telegram · HITL relay · dispatching couches
"""
import asyncio
import httpx
import json
import os
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List
import yaml

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

PORTS = CONFIG["ports"]
DB_PATH = Path("agent/memory/missions.db")
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
VITAL_LOOP_RUNNING = False


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, input TEXT, status TEXT,
        plan TEXT, result TEXT, created_at TEXT,
        completed_at TEXT, provider TEXT, duration_ms INTEGER
    )""")
    conn.commit()
    conn.close()


def save_mission(mission_id: str, input_text: str, status: str,
                 plan: dict = None, result: str = None,
                 provider: str = None, duration_ms: int = None):
    conn = sqlite3.connect(DB_PATH)
    now = datetime.utcnow().isoformat()
    existing = conn.execute("SELECT id FROM missions WHERE id=?", (mission_id,)).fetchone()
    if existing:
        conn.execute(
            """UPDATE missions SET status=?, plan=?, result=?,
               completed_at=?, provider=?, duration_ms=? WHERE id=?""",
            (status, json.dumps(plan) if plan else None, result,
             now if status in ["success", "failed"] else None,
             provider, duration_ms, mission_id)
        )
    else:
        conn.execute(
            "INSERT INTO missions VALUES (?,?,?,?,?,?,?,?,?)",
            (mission_id, input_text, status,
             json.dumps(plan) if plan else None, result, now, None, provider, duration_ms)
        )
    conn.commit()
    conn.close()


async def send_telegram(text: str):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if not token or not chat_id:
        print(f"[Queen] Telegram non configuré: {text[:80]}")
        return
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            await c.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}
            )
    except Exception as e:
        print(f"[Queen] Telegram erreur: {e}")


async def vital_loop():
    global VITAL_LOOP_RUNNING
    VITAL_LOOP_RUNNING = True
    interval = CONFIG["perception"]["interval_seconds"]
    print(f"[Queen] Boucle vitale démarrée — cycle {interval}s")
    while VITAL_LOOP_RUNNING:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                obs = await c.post(f"http://localhost:{PORTS['perception']}/observe")
                data = obs.json()
            anomalies = [a for a in data.get("anomalies", []) if a]
            if anomalies or data.get("screen", {}).get("changed"):
                context = f"Observations: {json.dumps(data, ensure_ascii=False)[:800]}"
                async with httpx.AsyncClient(timeout=30) as c:
                    r = await c.post(
                        f"http://localhost:{PORTS['brain']}/raw",
                        json={
                            "role": "strategist",
                            "prompt": f"Analyse cet état système et décide: faut-il agir? {context}\nRéponds JSON: {{\"should_act\": true/false, \"reason\": \"string\", \"action\": \"string\", \"risk\": \"low|medium|high\"}}",
                            "system": "Tu es un agent autonome. Tu décides si tu dois agir sur la machine."
                        }
                    )
                try:
                    dec = json.loads(r.json().get("content", "{}"))
                except Exception:
                    dec = {"should_act": False}
                if dec.get("should_act") and dec.get("risk") == "low":
                    print(f"[Queen] Action autonome: {dec.get('action')}")
                    asyncio.create_task(execute_mission(dec.get("action", ""), auto=True))
                elif dec.get("should_act") and dec.get("risk") in ["medium", "high"]:
                    await send_telegram(
                        f"🐝 *PICO-RUCHE* demande validation:\n`{dec.get('action')}`\nRisque: {dec.get('risk')}\nRépondre: ok / non"
                    )
        except Exception as e:
            print(f"[Queen] Boucle vitale erreur: {e}")
        await asyncio.sleep(interval)


async def execute_mission(input_text: str, auto: bool = False) -> dict:
    mission_id = str(uuid.uuid4())[:8]
    start = datetime.utcnow()
    save_mission(mission_id, input_text, "running")
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"http://localhost:{PORTS['brain']}/think",
                json={"mission": input_text, "mission_type": "mixed"}
            )
        plan_data = r.json()
        plan = plan_data.get("plan", {})
        provider = plan_data.get("provider", "unknown")
        save_mission(mission_id, input_text, "running", plan=plan, provider=provider)
        results = []
        for subtask in plan.get("subtasks", []):
            risk = subtask.get("risk", "medium")
            instruction = subtask.get("instruction", "")
            role = subtask.get("role", "worker")
            if risk == "high" and CONFIG["security"]["hitl_mode"] == "relay":
                await send_telegram(
                    f"🔴 *HITL requis*\nMission: `{input_text}`\nAction: `{instruction}`\nRisque: HIGH"
                )
                results.append({"subtask": subtask["id"], "status": "hitl_pending"})
                continue
            if role == "shell":
                async with httpx.AsyncClient(timeout=35) as c:
                    r = await c.post(
                        f"http://localhost:{PORTS['executor']}/shell",
                        json={"command": instruction}
                    )
                results.append({"subtask": subtask["id"], "result": r.json()})
            elif role == "vision":
                async with httpx.AsyncClient(timeout=20) as c:
                    r = await c.post(f"http://localhost:{PORTS['perception']}/observe")
                results.append({"subtask": subtask["id"], "result": r.json()})
            else:
                async with httpx.AsyncClient(timeout=60) as c:
                    r = await c.post(
                        f"http://localhost:{PORTS['brain']}/raw",
                        json={"role": role, "prompt": instruction}
                    )
                results.append({"subtask": subtask["id"], "result": r.json()})
        duration_ms = int((datetime.utcnow() - start).total_seconds() * 1000)
        result_str = json.dumps(results, ensure_ascii=False)[:2000]
        save_mission(mission_id, input_text, "success", plan=plan,
                     result=result_str, provider=provider, duration_ms=duration_ms)
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                await c.post(
                    f"http://localhost:{PORTS['memory']}/episode",
                    json={
                        "mission": input_text,
                        "result": result_str[:500],
                        "success": True,
                        "duration_ms": duration_ms,
                        "model_used": provider,
                        "skills_used": []
                    }
                )
        except Exception:
            pass
        return {
            "mission_id": mission_id,
            "status": "success",
            "plan": plan,
            "results": results,
            "duration_ms": duration_ms
        }
    except Exception as e:
        duration_ms = int((datetime.utcnow() - start).total_seconds() * 1000)
        save_mission(mission_id, input_text, "failed", result=str(e), duration_ms=duration_ms)
        return {"mission_id": mission_id, "status": "failed", "error": str(e)}


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    asyncio.create_task(vital_loop())
    print("🐝 PICO-RUCHE Agent actif — port 8001")
    yield
    global VITAL_LOOP_RUNNING
    VITAL_LOOP_RUNNING = False


app = FastAPI(title="PICO-RUCHE Queen", version="1.0.0", lifespan=lifespan)


class MissionRequest(BaseModel):
    command: str
    priority: int = 3


@app.post("/mission")
async def mission(req: MissionRequest):
    result = await execute_mission(req.command)
    if result.get("status") != "failed":
        await send_telegram(
            f"✅ Mission terminée en {result.get('duration_ms', 0)}ms\n`{req.command}`"
        )
    return result


@app.get("/missions")
async def list_missions(limit: int = 20):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT * FROM missions ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    cols = ["id", "input", "status", "plan", "result", "created_at", "completed_at", "provider", "duration_ms"]
    return {"missions": [dict(zip(cols, r)) for r in rows]}


@app.get("/status")
async def status():
    layers = {}
    for name, port in PORTS.items():
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"http://localhost:{port}/health")
                layers[name] = r.json()
        except Exception:
            layers[name] = {"status": "offline"}
    return {
        "agent": "PICO-RUCHE v1.0",
        "vital_loop": VITAL_LOOP_RUNNING,
        "layers": layers,
        "timestamp": datetime.utcnow().isoformat()
    }


@app.post("/telegram/webhook")
async def telegram_webhook(data: dict):
    message = data.get("message", {})
    text = message.get("text", "").strip()
    chat_id = str(message.get("chat", {}).get("id", ""))
    admin_id = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if chat_id != admin_id:
        return {"ok": False}
    if text.startswith("/mission "):
        cmd = text[9:]
        asyncio.create_task(execute_mission(cmd))
        await send_telegram(f"🐝 Mission lancée: `{cmd}`")
    elif text.startswith("/status"):
        st = await status()
        online = sum(1 for v in st["layers"].values() if v.get("status") == "ok")
        await send_telegram(
            f"🐝 PICO-RUCHE\n{online}/{len(st['layers'])} couches actives\nBoucle vitale: {'✅' if st['vital_loop'] else '❌'}"
        )
    elif text.lower() in ["ok", "oui", "yes"]:
        await send_telegram("✅ Action approuvée — exécution")
    elif text.lower() in ["non", "no", "stop"]:
        await send_telegram("🛑 Action annulée")
    return {"ok": True}


@app.get("/health")
async def health():
    return {"status": "ok", "layer": "queen", "vital_loop": VITAL_LOOP_RUNNING}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORTS["queen"])
