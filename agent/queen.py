"""
Orchestrateur central — port 8001
Boucle vitale 30s · missions Telegram · HITL complet · dispatching couches
"""
import asyncio
import httpx
import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import yaml
from dotenv import load_dotenv
load_dotenv()

# ─── Chemin racine projet (fix #3) ─────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent

# ─── WorldModel — grounding + état système ─────────────────────────────────────
import sys
sys.path.insert(0, str(ROOT))
try:
    from src.worldmodel.model import WorldModel
    _WORLD_MODEL_AVAILABLE = True
except ImportError:
    _WORLD_MODEL_AVAILABLE = False
    print("[Queen] WorldModel non disponible — fonctionnement sans grounding")

# ─── Import robuste quel que soit le working directory (fix #10) ───────────────
import sys as _sys
from pathlib import Path as _Path
_AGENT_DIR = _Path(__file__).resolve().parent
if str(_AGENT_DIR) not in _sys.path:
    _sys.path.insert(0, str(_AGENT_DIR))
from claude_architecte import get_architecte

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

PORTS = CONFIG["ports"]
DB_PATH = ROOT / "agent" / "memory" / "missions.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
VITAL_LOOP_RUNNING = False
_vital_loop_cycle  = 0          # compteur de cycles pour le heartbeat mémoire (toutes les 4×30s=2min)

# ─── HITL Queue ────────────────────────────────────────────────────────────────
# Structure : { hitl_id: { "action": str, "mission_id": str, "timestamp": datetime,
#                           "input_text": str, "subtask": dict } }
HITL_QUEUE: Dict[str, Dict[str, Any]] = {}

HITL_TIMEOUT = int(CONFIG.get("telegram", {}).get("hitl_timeout_seconds", 120))

# Verrous asyncio — initialisés dans lifespan() pour éviter RuntimeError (fix #1)
HITL_LOCK: asyncio.Lock | None = None
DB_LOCK: asyncio.Lock | None = None

# Throttle pour la boucle vitale (fix #9)
_HITL_SENT_TS: dict[str, float] = {}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ─── Validation des variables d'environnement (fix #7) ─────────────────────────

def _validate_env():
    """Vérifie les variables critiques au démarrage — fail fast si manquantes."""
    warnings = []
    if not os.environ.get("TELEGRAM_BOT_TOKEN"):
        warnings.append("⚠️  TELEGRAM_BOT_TOKEN absent — Telegram désactivé")
    if not os.environ.get("ADMIN_TELEGRAM_ID"):
        warnings.append("⚠️  ADMIN_TELEGRAM_ID absent — Telegram désactivé")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        warnings.append("⚠️  ANTHROPIC_API_KEY absent — Claude Architecte désactivé")
    for w in warnings:
        print(w)
    return len(warnings) == 0


# ─── Base de données ───────────────────────────────────────────────────────────

async def init_db():
    """Initialise la base SQLite via run_in_executor (fix #4)."""
    await asyncio.get_event_loop().run_in_executor(None, _init_db_sync)


def _init_db_sync():
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.execute("""CREATE TABLE IF NOT EXISTS missions (
        id TEXT PRIMARY KEY, input TEXT, status TEXT,
        plan TEXT, result TEXT, created_at TEXT,
        completed_at TEXT, provider TEXT, duration_ms INTEGER
    )""")
    conn.commit()
    conn.close()


async def save_mission(mission_id: str, input_text: str, status: str,
                       plan: dict = None, result: str = None,
                       provider: str = None, duration_ms: int = None):
    """Sauvegarde thread-safe via DB_LOCK + run_in_executor (fix #4)."""
    async with DB_LOCK:
        await asyncio.get_event_loop().run_in_executor(
            None, _save_mission_sync,
            mission_id, input_text, status, plan, result, provider, duration_ms
        )


def _save_mission_sync(mission_id, input_text, status, plan, result, provider, duration_ms):
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
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
    # Tronque les messages trop longs pour l'API Telegram (limite 4096) (fix #2)
    if len(text) > 4000:
        truncated = text[:3900]
        last_nl = truncated.rfind('\n')
        text = (truncated[:last_nl] if last_nl > 3000 else truncated) + '\n\n_(tronqué — demande la suite)_'

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
    async with HITL_LOCK:
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
    # Vérification post-envoi : l'entrée n'a pas déjà été poppée par le watchdog (fix #8)
    async with HITL_LOCK:
        if hitl_id not in HITL_QUEUE:
            return hitl_id  # déjà traité par le watchdog, on retourne quand même l'id
    # Planifie le timeout auto-annulation
    asyncio.create_task(_hitl_timeout_watchdog(hitl_id))
    return hitl_id


async def _hitl_timeout_watchdog(hitl_id: str):
    """Attend HITL_TIMEOUT secondes, puis annule si toujours en attente."""
    await asyncio.sleep(HITL_TIMEOUT)
    async with HITL_LOCK:
        entry = HITL_QUEUE.pop(hitl_id, None)
    if entry is not None:
        print(f"[Queen] HITL timeout: {hitl_id} — action annulée: {entry['action'][:60]}")
        await send_telegram(
            f"⏱ *HITL timeout* — ID `{hitl_id}` expiré après {HITL_TIMEOUT}s\n"
            f"Action annulée: `{entry['action'][:80]}`"
        )


async def hitl_approve(hitl_id: str):
    """Approuve et exécute l'action HITL correspondante."""
    async with HITL_LOCK:
        entry = HITL_QUEUE.pop(hitl_id, None)
    if entry is None:
        await send_telegram(f"⚠️ ID `{hitl_id}` inconnu ou déjà traité.")
        return
    await send_telegram(f"✅ *HITL approuvé* — `{hitl_id}`\nExécution en cours…")
    asyncio.create_task(_execute_hitl_subtask(entry))


async def hitl_reject(hitl_id: str):
    """Rejette l'action HITL correspondante."""
    async with HITL_LOCK:
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
    """Boucle de polling Telegram — long-polling 25s (0 latence, 0 CPU idle). P0.3."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    admin_id = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if not token or not admin_id:
        print("[Queen] Telegram polling désactivé — TELEGRAM_BOT_TOKEN ou ADMIN_TELEGRAM_ID manquant")
        return

    offset = 0
    print("[Queen] Polling Telegram démarré (long-polling 25s)")
    while VITAL_LOOP_RUNNING:
        try:
            # Long-polling côté serveur : Telegram attend 25s si rien à livrer
            # → latence ~0ms dès qu'un message arrive, vs ~2s auparavant
            async with httpx.AsyncClient(timeout=35) as c:
                r = await c.get(
                    f"https://api.telegram.org/bot{token}/getUpdates",
                    params={"timeout": 25, "offset": offset, "allowed_updates": ["message"]}
                )
                data = r.json()
            for update in data.get("result", []):
                offset = update["update_id"] + 1
                message = update.get("message", {})
                text = message.get("text", "").strip()
                chat_id = str(message.get("chat", {}).get("id", ""))
                if chat_id != admin_id:
                    continue
                # Non-bloquant : Claude peut prendre 30-60s, le polling continue
                asyncio.create_task(_handle_telegram_text(text))
        except Exception as e:
            print(f"[Queen] Telegram polling erreur: {e}")
            await asyncio.sleep(2)  # backoff uniquement sur erreur


async def _handle_telegram_text(text: str):
    """Dispatch centralisé des commandes Telegram (polling + webhook)."""
    text_lower = text.lower().strip()

    # ── Commandes HITL — priorité absolue ──────────────────────────────────
    if text_lower.startswith("ok-"):
        hitl_id = text[3:].strip().upper()
        await hitl_approve(hitl_id)
        return
    if text_lower.startswith("non-") or text_lower.startswith("no-"):
        sep = text_lower.index("-")
        hitl_id = text[sep + 1:].strip().upper()
        await hitl_reject(hitl_id)
        return

    # ── Commandes système directes ──────────────────────────────────────────
    if text.startswith("/status"):
        st = await status()
        online = sum(1 for v in st["layers"].values() if v.get("status") == "ok")
        await send_telegram(
            f"🐝 PICO-RUCHE\n{online}/{len(st['layers'])} couches actives\n"
            f"Boucle vitale: {'✅' if st['vital_loop'] else '❌'}\n"
            f"HITL en attente: {len(HITL_QUEUE)}"
        )
        return
    if text.startswith("/hitl"):
        if HITL_QUEUE:
            lines = [f"🔴 *HITL en attente* ({len(HITL_QUEUE)}):"]
            for hid, entry in HITL_QUEUE.items():
                age = int((_now_utc() - entry["timestamp"]).total_seconds())
                lines.append(f"• `{hid}` — {entry['action'][:60]} ({age}s)")
            await send_telegram("\n".join(lines))
        else:
            await send_telegram("✅ Aucune action HITL en attente.")
        return
    if text.startswith("/reset"):
        get_architecte().reset_history()
        await send_telegram("🔄 Historique de conversation réinitialisé.")
        return

    # ── Tout le reste → Claude Architecte ──────────────────────────────────
    # Claude a accès à tous les outils de la ruche via tool use.
    # Pas d'Ollama, pas de sous-agents, pas de screenshots inutiles.
    try:
        await send_telegram("⏳ _Architecte en train de réfléchir..._")
        architecte = get_architecte()
        response = await architecte.handle_message(text)
        await send_telegram(response)
    except ValueError as e:
        # ANTHROPIC_API_KEY manquant
        await send_telegram(f"❌ *Architecte non disponible*\n`{str(e)}`\nVérifie `.env` → `ANTHROPIC_API_KEY`")
    except Exception as e:
        print(f"[Queen] Claude Architecte erreur: {e}")
        await send_telegram(f"❌ Erreur Architecte: `{str(e)[:200]}`")


# ─── Boucle vitale ─────────────────────────────────────────────────────────────

async def vital_loop():
    global VITAL_LOOP_RUNNING
    VITAL_LOOP_RUNNING = True
    interval = CONFIG["perception"]["interval_seconds"]
    # Délai initial pour laisser toutes les couches démarrer
    startup_delay = 15
    print(f"[Queen] Boucle vitale démarrée — premier cycle dans {startup_delay}s, puis toutes les {interval}s")
    await asyncio.sleep(startup_delay)
    while VITAL_LOOP_RUNNING:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                obs = await c.post(f"http://localhost:{PORTS['perception']}/observe")
                data = obs.json()
            # Mise à jour WorldModel (grounding + état système)
            if _WORLD_MODEL_AVAILABLE:
                try:
                    wm = WorldModel.get_instance()
                    # Merge le snapshot système dans world_state.json
                    system_snap = data.get("system", {})
                    if system_snap:
                        await asyncio.get_event_loop().run_in_executor(None, wm.update, system_snap)
                    # Mise à jour app active si disponible
                    active = data.get("active_app") or data.get("frontmost_app")
                    if active:
                        await asyncio.get_event_loop().run_in_executor(
                            None, wm.set_active_app, active.get("name", ""), active.get("window_title", "")
                        )
                except Exception as _wm_err:
                    pass  # Silencieux — WorldModel ne doit jamais faire crasher la vital_loop
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
                except Exception as parse_err:
                    print(f"[Queen] vital_loop: réponse LLM non-JSON ({parse_err}) → should_act=False")
                    dec = {"should_act": False}
                if dec.get("should_act") and dec.get("risk") == "low":
                    print(f"[Queen] Action autonome: {dec.get('action')}")
                    asyncio.create_task(execute_mission(dec.get("action", ""), auto=True))
                elif dec.get("should_act") and dec.get("risk") in ["medium", "high"]:
                    # Throttle 5 minutes par action similaire (fix #9)
                    throttle_key = f"vital:{dec.get('action', '')[:50]}"
                    now_ts = time.monotonic()
                    if _HITL_SENT_TS.get(throttle_key, 0) + 300 > now_ts:
                        print(f"[Queen] HITL throttled (5min cooldown): {throttle_key[:50]}")
                    else:
                        _HITL_SENT_TS[throttle_key] = now_ts
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

        # ─── Heartbeat mémoire — toutes les 4 cycles (≈2 min) ──────────────────
        _vital_loop_cycle += 1
        if _vital_loop_cycle % 4 == 0:
            try:
                async with httpx.AsyncClient(timeout=5) as _hb_c:
                    _hb_r = await _hb_c.post(
                        f"http://localhost:{PORTS['memory']}/episode",
                        json={
                            "mission":     "heartbeat",
                            "result":      "all_layers_ok",
                            "success":     True,
                            "duration_ms": 0,
                            "model_used":  "system",
                            "skills_used": [],
                            "learned":     None,
                        }
                    )
                _hb_data = _hb_r.json()
                print(f"[Queen] 💓 Heartbeat mémoire sauvegardé — épisodes total: {_hb_data.get('total_episodes', '?')}")
            except Exception as _hb_err:
                print(f"[Queen] Heartbeat mémoire erreur: {_hb_err}")

        await asyncio.sleep(interval)


# ─── Exécution de missions ─────────────────────────────────────────────────────

async def _run_subtask(subtask: dict, input_text: str, mission_id: str) -> dict:
    """Exécute une seule sous-tâche — appelé selon le graphe de dépendances (fix #5)."""
    risk = subtask.get("risk", "medium")
    instruction = subtask.get("instruction", "")
    role = subtask.get("role", "worker")
    sid = subtask.get("id", "?")

    # HITL — retourne immédiatement (le watchdog gère la suite en background)
    if risk == "high" and CONFIG["security"]["hitl_mode"] == "relay":
        hitl_id = await hitl_request(
            action=instruction,
            input_text=input_text,
            subtask=subtask,
            mission_id=mission_id,
        )
        return {"subtask": sid, "status": "hitl_pending", "hitl_id": hitl_id}

    # Exécution directe selon le rôle
    try:
        if role == "shell":
            async with httpx.AsyncClient(timeout=35) as c:
                r = await c.post(
                    f"http://localhost:{PORTS['executor']}/shell",
                    json={"command": instruction}
                )
            return {"subtask": sid, "result": r.json()}
        elif role == "vision":
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(f"http://localhost:{PORTS['perception']}/observe")
            return {"subtask": sid, "result": r.json()}
        else:
            async with httpx.AsyncClient(timeout=60) as c:
                r = await c.post(
                    f"http://localhost:{PORTS['brain']}/raw",
                    json={"role": role, "prompt": instruction}
                )
            return {"subtask": sid, "result": r.json()}
    except Exception as e:
        return {"subtask": sid, "error": str(e)[:200]}


async def execute_mission(input_text: str, auto: bool = False) -> dict:
    mission_id = str(uuid.uuid4())[:8]
    start = _now_utc()
    await save_mission(mission_id, input_text, "running")
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            r = await c.post(
                f"http://localhost:{PORTS['brain']}/think",
                json={"mission": input_text, "mission_type": "mixed"}
            )
        plan_data = r.json()
        plan = plan_data.get("plan", {})
        provider = plan_data.get("provider", "unknown")
        await save_mission(mission_id, input_text, "running", plan=plan, provider=provider)

        # Exécution en vagues selon depends_on (fix #5)
        subtasks = plan.get("subtasks", [])
        subtasks_map = {st.get("id", str(i)): st for i, st in enumerate(subtasks)}
        completed: dict[str, dict] = {}  # id → résultat
        results = []

        remaining = list(subtasks)
        max_waves = len(subtasks) + 1  # évite boucle infinie si cycle
        wave = 0

        while remaining and wave < max_waves:
            wave += 1
            # Tâches prêtes = toutes leurs dépendances sont complétées
            ready = [
                st for st in remaining
                if all(dep in completed for dep in st.get("depends_on", []))
            ]
            if not ready:
                # Cycle de dépendances — exécuter quand même pour ne pas bloquer
                ready = remaining[:1]

            raw = await asyncio.gather(
                *[_run_subtask(st, input_text, mission_id) for st in ready],
                return_exceptions=True,
            )
            for st, res in zip(ready, raw):
                sid = st.get("id", "?")
                result = res if not isinstance(res, Exception) else {"error": str(res)}
                completed[sid] = result
                results.append(result)
                remaining.remove(st)

        duration_ms = int((_now_utc() - start).total_seconds() * 1000)
        result_str = json.dumps(results, ensure_ascii=False)[:2000]
        await save_mission(mission_id, input_text, "success", plan=plan,
                           result=result_str, provider=provider, duration_ms=duration_ms)
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                ep_r = await c.post(
                    f"http://localhost:{PORTS['memory']}/episode",
                    json={
                        "mission":     input_text,
                        "result":      result_str[:500],
                        "success":     True,
                        "duration_ms": duration_ms,
                        "model_used":  provider,
                        "skills_used": []
                    }
                )
            ep_data = ep_r.json()
            print(f"[Queen] 💾 Memory episode saved — mission: '{input_text[:60]}' | total_episodes: {ep_data.get('total_episodes', '?')}")
        except Exception as ep_err:
            print(f"[Queen] ⚠️ Memory episode save failed: {ep_err}")
        return {
            "mission_id": mission_id,
            "status": "success",
            "plan": plan,
            "results": results,
            "duration_ms": duration_ms
        }
    except Exception as e:
        duration_ms = int((_now_utc() - start).total_seconds() * 1000)
        await save_mission(mission_id, input_text, "failed", result=str(e), duration_ms=duration_ms)
        return {"mission_id": mission_id, "status": "failed", "error": str(e)}


# ─── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global HITL_LOCK, DB_LOCK, VITAL_LOOP_RUNNING
    # Initialisation des locks dans l'event loop (fix #1)
    HITL_LOCK = asyncio.Lock()
    DB_LOCK = asyncio.Lock()
    await init_db()
    _validate_env()  # Validation des variables d'environnement (fix #7)
    VITAL_LOOP_RUNNING = True   # must be True before tasks start
    asyncio.create_task(vital_loop())
    asyncio.create_task(telegram_polling_loop())
    print("🐝 PICO-RUCHE Agent actif — port 8001")
    yield
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
    async with DB_LOCK:
        rows = await asyncio.get_event_loop().run_in_executor(
            None, _list_missions_sync, limit
        )
    cols = ["id", "input", "status", "plan", "result", "created_at", "completed_at", "provider", "duration_ms"]
    return {"missions": [dict(zip(cols, r)) for r in rows]}


def _list_missions_sync(limit: int):
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    rows = conn.execute(
        "SELECT * FROM missions ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return rows


@app.get("/status")
async def status():
    """P0.2 — health checks en parallèle (14s → 2s max)."""
    async def _check(name: str, port: int) -> tuple[str, dict]:
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"http://localhost:{port}/health")
                return name, r.json()
        except Exception:
            return name, {"status": "offline"}

    results = await asyncio.gather(*[_check(n, p) for n, p in PORTS.items()])
    layers = dict(results)
    world_model_info = {}
    if _WORLD_MODEL_AVAILABLE:
        try:
            wm = WorldModel.get_instance()
            world_model_info = {
                "active_app": wm.get_frontmost_app(),
                "cpu_high": wm.is_cpu_high(),
                "disk_low": wm.is_disk_space_low(),
            }
        except Exception:
            pass
    return {
        "agent": "PICO-RUCHE v1.0",
        "vital_loop": VITAL_LOOP_RUNNING,
        "layers": layers,
        "hitl_pending": len(HITL_QUEUE),
        "world_model": world_model_info,
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
    """Webhook Telegram — utilisé uniquement si le polling est désactivé (WEBHOOK_MODE=true)."""
    if os.environ.get("WEBHOOK_MODE", "false").lower() != "true":
        # En mode polling (défaut), on ignore le webhook pour éviter les doublons
        return {"ok": True, "skipped": "polling_mode"}
    message = data.get("message", {})
    text = message.get("text", "").strip()
    chat_id = str(message.get("chat", {}).get("id", ""))
    admin_id = os.environ.get("ADMIN_TELEGRAM_ID", "")
    if chat_id != admin_id:
        return {"ok": False}
    asyncio.create_task(_handle_telegram_text(text))
    return {"ok": True}


@app.get("/health")
async def health():
    world_model_info = {}
    if _WORLD_MODEL_AVAILABLE:
        try:
            wm = WorldModel.get_instance()
            world_model_info = {
                "active_app": wm.get_frontmost_app(),
                "cpu_high": wm.is_cpu_high(),
                "disk_low": wm.is_disk_space_low(),
            }
        except Exception:
            pass
    return {
        "status": "ok",
        "layer": "queen",
        "vital_loop": VITAL_LOOP_RUNNING,
        "hitl_pending": len(HITL_QUEUE),
        "world_model": world_model_info,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORTS["queen"])
