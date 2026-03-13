"""
Pont Python → MCP Node.js — port 8007
Traduit les appels Python vers les endpoints REST /mcp/* de la queen Node.js.
Chaque outil MCP dispose maintenant d'un endpoint dédié sur :3000/mcp/<tool>.
"""
import httpx
import json
import os
import asyncio
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Optional
import yaml
from dotenv import load_dotenv
load_dotenv()

ROOT = Path(__file__).resolve().parent.parent

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE MCP Bridge", version="2.0.0")

MCP_BASE = CONFIG["mcp"]["node_base_url"]
# FIX 5 — Timeout borné entre 5 et 60s (empêche des valeurs aberrantes depuis l'env)
MCP_TIMEOUT = max(5, min(60, int(os.environ.get("MCP_TIMEOUT", str(CONFIG["mcp"]["timeout"])))))

# Port Node.js extrait depuis MCP_BASE pour le ping /health
_node_base_parts = MCP_BASE.rstrip("/").rsplit(":", 1)
NODE_PORT = int(_node_base_parts[-1]) if _node_base_parts[-1].isdigit() else 3000

# Mapping outil → endpoint /mcp/<tool>
# Construit dynamiquement à partir de agent_config.yml (section mcp.tools)
_TOOL_ENDPOINTS: dict[str, str] = {
    t["name"]: t["endpoint"]
    for t in CONFIG["mcp"].get("tools", [])
}


async def call_mcp(tool: str, action: str, params: dict = {}) -> dict:
    """
    Appelle directement POST /mcp/<tool> sur la queen Node.js.
    Body : { action, params }
    """
    endpoint = _TOOL_ENDPOINTS.get(tool)
    if not endpoint:
        # Outil non configuré — retourne une erreur explicite
        return {
            "error": f"Outil MCP inconnu: {tool}",
            "known_tools": list(_TOOL_ENDPOINTS.keys()),
        }

    url = f"{MCP_BASE}{endpoint}"
    payload = {"action": action, "params": params}

    # FIX 6 — Retry avec backoff de 2s sur ConnectError ou timeout
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=MCP_TIMEOUT) as c:
                r = await c.post(url, json=payload)
                r.raise_for_status()
                return r.json()
        except (httpx.ConnectError, httpx.TimeoutException) as e:
            if attempt == 0:
                await asyncio.sleep(2)
                continue
            return {
                "error": "Node.js queen non démarrée ou timeout",
                "hint": "npm start dans PICO-RUCHE ou STANDALONE_MODE=true node src/queen_oss.js",
                "detail": str(e),
            }
        except httpx.HTTPStatusError as e:
            return {"error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"}
        except Exception as e:
            return {"error": str(e)}


class MCPRequest(BaseModel):
    tool: str
    action: str
    params: dict = {}


# ── Endpoint générique ────────────────────────────────────────────────────────

@app.post("/call")
async def mcp_call(req: MCPRequest):
    return await call_mcp(req.tool, req.action, req.params)


# ── OS Control ───────────────────────────────────────────────────────────────

@app.post("/os/click")
async def os_click(data: dict):
    return await call_mcp("os-control", "click", data)


@app.post("/os/type")
async def os_type(data: dict):
    return await call_mcp("os-control", "typeText", data)


@app.post("/os/screenshot")
async def os_screenshot(data: dict = {}):
    return await call_mcp("os-control", "screenshot", data)


@app.post("/os/scroll")
async def os_scroll(data: dict):
    return await call_mcp("os-control", "scrollTo", data)


@app.post("/os/keypress")
async def os_keypress(data: dict):
    return await call_mcp("os-control", "keyPress", data)


# ── Terminal ─────────────────────────────────────────────────────────────────

@app.post("/terminal/exec")
async def terminal_exec(data: dict):
    return await call_mcp("terminal", "exec", data)


@app.post("/terminal/exec-safe")
async def terminal_exec_safe(data: dict):
    return await call_mcp("terminal", "execSafe", data)


@app.get("/terminal/processes")
async def terminal_list_processes():
    return await call_mcp("terminal", "listProcesses", {})


@app.post("/terminal/kill")
async def terminal_kill(data: dict):
    return await call_mcp("terminal", "killProcess", data)


# ── Vision ───────────────────────────────────────────────────────────────────

@app.post("/vision/analyze")
async def vision_analyze(data: dict):
    return await call_mcp("vision", "analyzeScreen", data)


@app.post("/vision/find-element")
async def vision_find_element(data: dict):
    return await call_mcp("vision", "findElement", data)


@app.post("/vision/watch-change")
async def vision_watch_change(data: dict):
    return await call_mcp("vision", "watchChange", data)


# ── Vault ────────────────────────────────────────────────────────────────────

@app.post("/vault/store")
async def vault_store(data: dict):
    return await call_mcp("vault", "storeExperience", data)


@app.post("/vault/search")
async def vault_search(data: dict):
    return await call_mcp("vault", "findSimilar", data)


@app.get("/vault/profile")
async def vault_profile():
    return await call_mcp("vault", "getProfile", {})


@app.post("/vault/profile")
async def vault_update_profile(data: dict):
    return await call_mcp("vault", "updateProfile", data)


@app.post("/vault/rule")
async def vault_add_rule(data: dict):
    return await call_mcp("vault", "addRule", data)


# ── Rollback ─────────────────────────────────────────────────────────────────

@app.post("/rollback/snapshot")
async def rollback_snapshot(data: dict):
    return await call_mcp("rollback", "createSnapshot", data)


@app.get("/rollback/snapshots")
async def rollback_list():
    return await call_mcp("rollback", "listSnapshots", {})


@app.post("/rollback/restore")
async def rollback_restore(data: dict):
    return await call_mcp("rollback", "restore", data)


@app.post("/rollback/purge")
async def rollback_purge(data: dict = {}):
    return await call_mcp("rollback", "purgeOldSnapshots", data)


# ── Skill Factory ────────────────────────────────────────────────────────────

@app.post("/skill-factory/create")
async def skill_create(data: dict):
    return await call_mcp("skill-factory", "createSkill", data)


@app.post("/skill-factory/test")
async def skill_test(data: dict):
    return await call_mcp("skill-factory", "testSkill", data)


@app.post("/skill-factory/register")
async def skill_register(data: dict):
    return await call_mcp("skill-factory", "registerSkill", data)


@app.post("/skill-factory/evolve")
async def skill_evolve(data: dict):
    return await call_mcp("skill-factory", "evolveSkill", data)


@app.get("/skill-factory/list")
async def skill_list():
    return await call_mcp("skill-factory", "listSkills", {})


# ── Janitor ──────────────────────────────────────────────────────────────────

@app.post("/janitor/purge-temp")
async def janitor_purge_temp():
    return await call_mcp("janitor", "purgeTemp", {})


@app.post("/janitor/rotate-logs")
async def janitor_rotate_logs(data: dict = {}):
    return await call_mcp("janitor", "rotateLogs", data)


@app.post("/janitor/gc-ram")
async def janitor_gc_ram():
    return await call_mcp("janitor", "gcRAM", {})


@app.get("/janitor/stats")
async def janitor_stats():
    return await call_mcp("janitor", "getStats", {})


# ── Utilitaires ──────────────────────────────────────────────────────────────

@app.get("/tools")
async def list_tools():
    return {
        "tools": CONFIG["mcp"]["tools"],
        "base_url": MCP_BASE,
        "endpoints": _TOOL_ENDPOINTS,
    }


@app.get("/health")
async def health():
    mcp_ok = False
    mcp_error = None
    mcp_endpoints: list = []
    # Tente plusieurs endpoints de santé connus de la queen Node.js
    for probe_path in ["/mcp/health", "/api/status", "/api/health"]:
        try:
            async with httpx.AsyncClient(timeout=2) as c:
                r = await c.get(f"{MCP_BASE}{probe_path}")
                if r.status_code == 200:
                    mcp_ok = True
                    mcp_endpoints = r.json().get("endpoints", [])
                    break
        except Exception as e:
            mcp_error = str(e)

    # FIX 7 — Ping dédié GET /api/health pour confirmer que la queen répond
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"http://localhost:{NODE_PORT}/api/health")
            node_ok = r.status_code == 200
    except Exception:
        node_ok = False

    return {
        "status": "ok",
        "layer": "mcp_bridge",
        "node_queen_alive": node_ok,
        "node_port": NODE_PORT,
        "mcp_node_available": mcp_ok,
        "mcp_base_url": MCP_BASE,
        "mcp_endpoints_active": len(mcp_endpoints),
        "mcp_error": mcp_error if not mcp_ok else None,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["mcp_bridge"])
