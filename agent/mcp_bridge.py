"""
Pont Python → MCP Node.js — port 8007
Traduit les appels Python vers les modules MCP Node.js existants
"""
import httpx
import json
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Optional
import yaml

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE MCP Bridge", version="1.0.0")

MCP_BASE = CONFIG["mcp"]["node_base_url"]
MCP_TIMEOUT = CONFIG["mcp"]["timeout"]


async def call_mcp(tool: str, action: str, params: dict = {}) -> dict:
    endpoint = next((t["endpoint"] for t in CONFIG["mcp"]["tools"] if t["name"] == tool), None)
    if not endpoint:
        raise HTTPException(status_code=404, detail=f"Outil MCP inconnu: {tool}")
    async with httpx.AsyncClient(timeout=MCP_TIMEOUT) as c:
        try:
            r = await c.post(f"{MCP_BASE}{endpoint}/{action}", json=params)
            r.raise_for_status()
            return r.json()
        except httpx.ConnectError:
            return {"error": "MCP Node.js non démarré", "hint": "npm start dans PICO-RUCHE"}
        except Exception as e:
            return {"error": str(e)}


class MCPRequest(BaseModel):
    tool: str
    action: str
    params: dict = {}


@app.post("/call")
async def mcp_call(req: MCPRequest):
    return await call_mcp(req.tool, req.action, req.params)


@app.post("/os/click")
async def os_click(data: dict):
    return await call_mcp("os-control", "click", data)


@app.post("/os/type")
async def os_type(data: dict):
    return await call_mcp("os-control", "typeText", data)


@app.post("/os/screenshot")
async def os_screenshot(data: dict = {}):
    return await call_mcp("os-control", "screenshot", data)


@app.post("/terminal/exec")
async def terminal_exec(data: dict):
    return await call_mcp("terminal", "execSafe", data)


@app.post("/vision/analyze")
async def vision_analyze(data: dict):
    return await call_mcp("vision", "analyzeScreen", data)


@app.post("/vault/store")
async def vault_store(data: dict):
    return await call_mcp("vault", "storeExperience", data)


@app.post("/vault/search")
async def vault_search(data: dict):
    return await call_mcp("vault", "findSimilar", data)


@app.post("/rollback/snapshot")
async def rollback_snapshot(data: dict):
    return await call_mcp("rollback", "createSnapshot", data)


@app.get("/tools")
async def list_tools():
    return {"tools": CONFIG["mcp"]["tools"], "base_url": MCP_BASE}


@app.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=2) as c:
            r = await c.get(f"{MCP_BASE}/health")
            mcp_ok = r.status_code == 200
    except Exception:
        mcp_ok = False
    return {"status": "ok", "layer": "mcp_bridge", "mcp_node_available": mcp_ok}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["mcp_bridge"])
