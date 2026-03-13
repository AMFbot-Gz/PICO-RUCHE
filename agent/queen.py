"""
Orchestrateur central — port 8001
Boucle vitale 30s · missions Telegram · HITL complet · dispatching couches
"""
import asyncio
import httpx
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import yaml

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

PORTS = CONFIG["ports"]
DB_PATH = Path("agent/memory/missions.db")
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
VITAL_LOOP_RUNNING = False

# ─── HITL Queue ────────────────────────────────────────────────────────────────
# Structure : { hitl_id: { "action": str, "mission_id": str, "timestamp": datetime,
#                           "input_text": str, "subtask": dict } }
HITL_QUEUE: Dict[str, Dict[str, Any]] = {}

HITL_TIMEOUT = int(CONFIG.get("telegram", {}).get("hitl_timeout_seconds", 120))


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ─── Base de données ───────────────────────────────────────────────────────────

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
    now = _now_utc().isoformat()
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


# ─── Telegram helpers ──────────────────────────────────────────────────────────

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


# ─── HITL helpers ──────────────────────────────────────────────────────────────

async def hitl_request(action: str, input_text: str, subtask: dict, mission_id: str) -> str:
    """
    Enregistre une action HIGH-risk dans la HITL_QUEUE, envoie un message Telegram
    avec l'ID unique, puis retourne cet ID.
    """
    hitl_id = str(uuid.uuid4())[:8].upper()
    HITL_QUEUE[hitl_id] = {
        "action": action,
        "input_text": input_text,
        "mission_id": mission_id,
        "subtask": subtask,
        "timestamp": _now_utc(),
    }
    await send_telegram(
        f"🔴 *HITL requis* — ID: `{hitl_id}`\n"
        f"Mission: `{input_text[:80]}`\n"
        f"Action: `{action[:120]}`\n"
        f"Risque: HIGH\n\n"
        f"✅ Approuver: `ok-{hitl_id}`\n"
        f"🛑 Annuler: `non-{hitl_id}`\n"
        f"⏱ Timeout: {HITL_TIMEOUT}s"
    )
    # Planifie le timeout auto-annulation
    asyncio.create_task(_hitl_timeout_watchdog(hitl_id))
    return hitl_id


async def _hitl_timeout_watchdog(hitl_id: str):
    """Attend HITL_TIMEOUT secondes, puis annule si toujours en attente."""
    await asyncio.sleep(HITL_TIMEOUT)
    if hitl_id in HITL_QUEUE:
        entry = HITL_QUEUE.pop(hitl_id)
        print(f"[Queen] HITL timeout: {hitl_id} — action annulée: {entry['action'][:60]}")
        await send_telegram(
            f"⏱ *HITL timeout* — ID `{hitl_id}` expiré après {HITL_TIMEOUT}s\n"
            f"Action annulée: `{entry['action'][:80]}`"
        )


async def hitl_approve(hitl_id: str):
    """Approuve et exécute l'action HITL correspondante."""
    entry = HITL_QUEUE.pop(hitl_id, None)
    if entry is None:
        await send_telegram(f"⚠️ ID `{hitl_id}` inconnu ou déjà traité.")
        return
    await send_telegram(f"✅ *HITL approuvé* — `{hitl_id}`\nExécution en cours…")
    asyncio.create_task(_execute_hitl_subtask(entry))


async def hitl_reject(hitl_id: str):
    """Rejette l'action HITL correspondante."""
    entry = HITL_QUEUE.pop(hitl_id, None)
    if entry is None:
        await send_telegram(f"⚠️ ID `{hitl_id}` inconnu ou déjà traité.")
        return
    await send_telegram(
        f"🛑 *HITL annulé* — `{hitl_id}`\n"
        f"Action abandonnée: `{entry['action'][:80]}`"
    )


async def _execute_hitl_subtask(entry: dict):
    """Exécute la sous-tâche approuvée via la couche executor ou brain."""
    action = entry["action"]
    subtask = entry.get("subtask", {})
    role = subtask.get("role", "worker")
    try:
        if role == "shell":
            async with httpx.AsyncClient(timeout=35) as c:
                r = await c.post(
                    f"http://localhost:{PORTS['executor']}/shell",
                    json={"command": action}
                )
            result = r.json()
        else:
            async with httpx.AsyncClient(timeout=60) as c:
                r = await c.post(
                    f"http://localhost:{PORTS['brain']}/raw",
                    json={"role": role, "prompt": action}
                )
            result = r.json()
        result_str = json.dumps(result, ensure_ascii=False)[:500]
        await send_telegram(
            f"✅ *HITL exécuté* — `{entry.get('mission_id', '?')}`\n"
            f"Résultat: `{result_str[:200]}`"
        )
    except Exception as e:
        await send_telegram(
            f"❌ *HITL erreur* — `{entry.get('mission_id', '?')}`\n`{str(e)[:200]}`"
        )


# ─── Polling Telegram ──────────────────────────────────────────────────────────

async def telegram_polling_loop():
    """Boucle de polling Telegram — interroge getUpdates toutes les 2s."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    admin_id = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if not token or not admin_id:
        print("[Queen] Telegram polling désactivé — TELEGRAM_BOT_TOKEN ou ADMIN_TELEGRAM_ID manquant")
        return

    offset = 0
    print("[Queen] Polling Telegram démarré")
    while VITAL_LOOP_RUNNING:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.get(
                    f"https://api.telegram.org/bot{token}/getUpdates",
                    params={"timeout": 1, "offset": offset, "allowed_updates": ["message"]}
                )
                data = r.json()
            for update in data.get("result", []):
                offset = update["update_id"] + 1
                message = update.get("message", {})
                text = message.get("text", "").strip()
                chat_id = str(message.get("chat", {}).get("id", ""))
                if chat_id != admin_id:
                    continue
                await _handle_telegram_text(text)
        except Exception as e:
            print(f"[Queen] Telegram polling erreur: {e}")
        await asyncio.sleep(2)


async def _handle_telegram_text(text: str):
    """Dispatch centralisé des commandes Telegram (polling + webhook)."""
    text_lower = text.lower().strip()

    # ── Commandes HITL avec ID ──────────────────────────────────────────────
    if text_lower.startswith("ok-"):
        hitl_id = text[3:].strip().upper()
        await hitl_approve(hitl_id)
        return
    if text_lower.startswith("non-") or text_lower.startswith("no-"):
        sep = text_lower.index("-")
        hitl_id = text[sep + 1:].strip().upper()
        await hitl_reject(hitl_id)
        return

    # ── Commandes générales ─────────────────────────────────────────────────
    if text.startswith("/mission "):
        cmd = text[9:].strip()
        if cmd:
            asyncio.create_task(execute_mission(cmd))
            await send_telegram(f"🐝 Mission lancée: `{cmd}`")
    elif text.startswith("/status"):
        st = await status()
        online = sum(1 for v in st["layers"].values() if v.get("status") == "ok")
        await send_telegram(
            f"🐝 PICO-RUCHE\n{online}/{len(st['layers'])} couches actives\n"
            f"Boucle vitale: {'✅' if st['vital_loop'] else '❌'}\n"
            f"HITL en attente: {len(HITL_QUEUE)}"
        )
    elif text.startswith("/hitl"):
        if HITL_QUEUE:
            lines = [f"🔴 *HITL en attente* ({len(HITL_QUEUE)}):"]
            for hid, entry in HITL_QUEUE.items():
                age = int((_now_utc() - entry["timestamp"]).total_seconds())
                lines.append(f"• `{hid}` — {entry['action'][:60]} ({age}s)")
            await send_telegram("\n".join(lines))
        else:
            await send_telegram("✅ Aucune action HITL en attente.")
    # Réponses génériques sans ID (rétro-compatibilité)
    elif text_lower in ["ok", "oui", "yes"]:
        await send_telegram(
            "ℹ️ Utiliser `ok-ID` pour approuver une action spécifique.\n"
            f"Actions en attente: {len(HITL_QUEUE)}"
        )
    elif text_lower in ["non", "no", "stop"]:
        await send_telegram(
            "ℹ️ Utiliser `non-ID` pour annuler une action spécifique.\n"
            f"Actions en attente: {len(HITL_QUEUE)}"
        )


# ─── Boucle vitale ─────────────────────────────────────────────────────────────

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
                            "prompt": (
                                f"Analyse cet état système et décide: faut-il agir? {context}\n"
                                "Réponds JSON: {\"should_act\": true/false, \"reason\": \"string\", "
                                "\"action\": \"string\", \"risk\": \"low|medium|high\"}"
                            ),
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
                    # Créer une entrée HITL pour les actions détectées par la boucle vitale
                    fake_subtask = {"role": "worker", "risk": dec.get("risk"), "id": "vital_loop"}
                    mission_id = f"vital-{str(uuid.uuid4())[:6]}"
                    await hitl_request(
                        action=dec.get("action", ""),
                        input_text=f"[auto] {dec.get('reason', '')}",
                        subtask=fake_subtask,
                        mission_id=mission_id,
                    )
        except Exception as e:
            print(f"[Queen] Boucle vitale erreur: {e}")
        await asyncio.sleep(interval)


# ─── Exécution de missions ─────────────────────────────────────────────────────

async def execute_mission(input_text: str, auto: bool = False) -> dict:
    mission_id = str(uuid.uuid4())[:8]
    start = _now_utc()
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
                hitl_id = await hitl_request(
                    action=instruction,
                    input_text=input_text,
                    subtask=subtask,
                    mission_id=mission_id,
                )
                results.append({
                    "subtask": subtask.get("id"),
                    "status": "hitl_pending",
                    "hitl_id": hitl_id,
                })
                continue
            if role == "shell":
                async with httpx.AsyncClient(timeout=35) as c:
                    r = await c.post(
                        f"http://localhost:{PORTS['executor']}/shell",
                        json={"command": instruction}
                    )
                results.append({"subtask": subtask.get("id"), "result": r.json()})
            elif role == "vision":
                async with httpx.AsyncClient(timeout=20) as c:
                    r = await c.post(f"http://localhost:{PORTS['perception']}/observe")
                results.append({"subtask": subtask.get("id"), "result": r.json()})
            else:
                async with httpx.AsyncClient(timeout=60) as c:
                    r = await c.post(
                        f"http://localhost:{PORTS['brain']}/raw",
                        json={"role": role, "prompt": instruction}
                    )
                results.append({"subtask": subtask.get("id"), "result": r.json()})
        duration_ms = int((_now_utc() - start).total_seconds() * 1000)
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
        duration_ms = int((_now_utc() - start).total_seconds() * 1000)
        save_mission(mission_id, input_text, "failed", result=str(e), duration_ms=duration_ms)
        return {"mission_id": mission_id, "status": "failed", "error": str(e)}


# ─── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    asyncio.create_task(vital_loop())
    asyncio.create_task(telegram_polling_loop())
    print("🐝 PICO-RUCHE Agent actif — port 8001")
    yield
    global VITAL_LOOP_RUNNING
    VITAL_LOOP_RUNNING = False


app = FastAPI(title="PICO-RUCHE Queen", version="1.0.0", lifespan=lifespan)


# ─── Modèles Pydantic ──────────────────────────────────────────────────────────

class MissionRequest(BaseModel):
    command: str
    priority: int = 3


# ─── Endpoints ─────────────────────────────────────────────────────────────────

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
        "hitl_pending": len(HITL_QUEUE),
        "timestamp": _now_utc().isoformat()
    }


@app.get("/hitl/queue")
async def hitl_queue():
    """Retourne toutes les actions HITL en attente de validation humaine."""
    now = _now_utc()
    items = []
    for hitl_id, entry in HITL_QUEUE.items():
        age_s = int((now - entry["timestamp"]).total_seconds())
        remaining_s = max(0, HITL_TIMEOUT - age_s)
        items.append({
            "hitl_id": hitl_id,
            "action": entry["action"],
            "mission_id": entry["mission_id"],
            "input_text": entry["input_text"],
            "age_seconds": age_s,
            "timeout_in_seconds": remaining_s,
            "timestamp": entry["timestamp"].isoformat(),
        })
    return {
        "count": len(items),
        "timeout_seconds": HITL_TIMEOUT,
        "items": items
    }


@app.post("/telegram/webhook")
async def telegram_webhook(data: dict):
    message = data.get("message", {})
    text = message.get("text", "").strip()
    chat_id = str(message.get("chat", {}).get("id", ""))
    admin_id = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if chat_id != admin_id:
        return {"ok": False}
    await _handle_telegram_text(text)
    return {"ok": True}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "layer": "queen",
        "vital_loop": VITAL_LOOP_RUNNING,
        "hitl_pending": len(HITL_QUEUE),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORTS["queen"])
