"""
Couche cerveau — port 8003
MLX ou Ollama · routing modèles · compression contexte · planification
"""
import httpx
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional, Any
import yaml

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Brain", version="1.0.0")

OLLAMA_URL = CONFIG["ollama"]["base_url"]
MLX_URL = CONFIG["mlx"]["server_url"]
MODELS = CONFIG["ollama"]["models"]
COMPRESS_THRESHOLD = CONFIG["brain"]["compress_threshold"]


def mlx_available() -> bool:
    if not CONFIG["mlx"]["enabled"]:
        return False
    try:
        r = httpx.get(f"{MLX_URL.replace('/v1', '')}/health", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def estimate_tokens(text: str) -> int:
    return len(text) // 4


async def call_ollama(model: str, messages: list, system: str = "") -> str:
    payload = {"model": model, "messages": messages, "stream": False}
    if system:
        payload["messages"] = [{"role": "system", "content": system}] + messages
    async with httpx.AsyncClient(timeout=CONFIG["ollama"]["timeout"]) as client:
        r = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
        r.raise_for_status()
        return r.json()["message"]["content"]


async def call_mlx(messages: list, system: str = "") -> str:
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.extend(messages)
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(f"{MLX_URL}/chat/completions",
                              json={"model": "local", "messages": msgs, "max_tokens": 2000})
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


async def call_kimi(messages: list, system: str = "") -> str:
    key = os.environ.get("KIMI_API_KEY", "")
    if not key:
        raise ValueError("KIMI_API_KEY absent")
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.extend(messages)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            "https://api.moonshot.cn/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": "moonshot-v1-8k", "messages": msgs, "max_tokens": 2000}
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


async def llm(role: str, messages: list, system: str = "") -> dict:
    model = MODELS.get(role, MODELS["worker"])
    if role == "strategist" and mlx_available():
        try:
            content = await call_mlx(messages, system)
            return {"content": content, "provider": "mlx", "model": "qwen3-mlx"}
        except Exception as e:
            print(f"[Brain] MLX failed: {e} → Ollama")
    try:
        content = await call_ollama(model, messages, system)
        return {"content": content, "provider": "ollama", "model": model}
    except Exception as e:
        print(f"[Brain] Ollama failed: {e} → Kimi")
    try:
        content = await call_kimi(messages, system)
        return {"content": content, "provider": "kimi", "model": "moonshot-v1-8k"}
    except Exception as e:
        raise RuntimeError(f"Tous les providers ont échoué: {e}")


async def compress_context(messages: list) -> str:
    history = "\n".join([f"{m['role']}: {m['content']}" for m in messages])
    result = await call_ollama(MODELS["compressor"], [
        {"role": "user", "content": f"Résume en moins de 400 tokens. Garde: décisions, erreurs, état actuel, prochaine étape. Supprime: répétitions, politesses.\n\n{history}"}
    ])
    return result


def load_domain_context(mission_type: str) -> str:
    ctx_file = Path(f"support/domain-contexts/{mission_type}.md")
    mem_file = Path("agent/memory/persistent.md")
    ctx = ""
    if ctx_file.exists():
        ctx += ctx_file.read_text()
    if mem_file.exists():
        ctx += "\n\n" + mem_file.read_text()[-2000:]
    return ctx


class ThinkRequest(BaseModel):
    mission: str
    history: List[dict] = []
    mission_type: str = "code"
    role: str = "strategist"


class CompressRequest(BaseModel):
    messages: List[dict]


@app.post("/think")
async def think(req: ThinkRequest):
    messages = req.history.copy()
    total_text = " ".join([m.get("content", "") for m in messages])
    if estimate_tokens(total_text) > COMPRESS_THRESHOLD:
        print(f"[Brain] Contexte > {COMPRESS_THRESHOLD} tokens → compression")
        compressed = await compress_context(messages)
        messages = [{"role": "assistant", "content": f"[Contexte résumé]: {compressed}"}]
    domain_ctx = load_domain_context(req.mission_type)
    system_prompt = f"""Tu es le cerveau de PICO-RUCHE (Ghost OS v5.0.0).
Tu analyses la situation et décomposes la mission en sous-tâches atomiques.
Maximum 5 sous-tâches. Réponds UNIQUEMENT en JSON valide.
Format: {{"subtasks": [{{"id": "1", "role": "worker|vision|repair|shell", "instruction": "string", "risk": "low|medium|high"}}], "reasoning": "string", "estimated_duration": "Xs"}}
{f"Contexte domaine:{chr(10)}{domain_ctx[:1000]}" if domain_ctx else ""}"""
    messages.append({"role": "user", "content": req.mission})
    result = await llm(req.role, messages, system_prompt)
    try:
        plan = json.loads(result["content"])
    except Exception:
        plan = {
            "subtasks": [{"id": "1", "role": "worker", "instruction": req.mission, "risk": "medium"}],
            "reasoning": result["content"],
            "estimated_duration": "?"
        }
    return {
        "plan": plan,
        "provider": result["provider"],
        "model": result["model"],
        "tokens_estimated": estimate_tokens(total_text)
    }


@app.post("/compress")
async def compress(req: CompressRequest):
    compressed = await compress_context(req.messages)
    return {
        "compressed": compressed,
        "original_tokens": estimate_tokens(" ".join([m.get("content", "") for m in req.messages])),
        "compressed_tokens": estimate_tokens(compressed)
    }


@app.post("/raw")
async def raw_llm(req: dict):
    result = await llm(
        req.get("role", "worker"),
        req.get("messages", [{"role": "user", "content": req.get("prompt", "")}]),
        req.get("system", "")
    )
    return result


@app.get("/health")
async def health():
    mlx_ok = mlx_available()
    return {"status": "ok", "layer": "brain", "mlx": mlx_ok, "ollama": OLLAMA_URL, "models": MODELS}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["brain"])
