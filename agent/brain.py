"""
Couche cerveau — port 8003
Claude API · MLX · Ollama · routing modèles · compression contexte · planification
Chaîne de fallback : Claude (claude-opus-4-6) → MLX → Ollama → Kimi → OpenAI
"""
import asyncio
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
from dotenv import load_dotenv
load_dotenv()

ROOT = Path(__file__).resolve().parent.parent

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Brain", version="1.0.0")

OLLAMA_URL = CONFIG["ollama"]["base_url"]
MLX_URL = CONFIG["mlx"]["server_url"]
MODELS = CONFIG["ollama"]["models"]
COMPRESS_THRESHOLD = CONFIG["brain"]["compress_threshold"]
CLAUDE_MODEL = "claude-opus-4-6"


def claude_available() -> bool:
    """Vérifie si ANTHROPIC_API_KEY est présente et non vide."""
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


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
    async with httpx.AsyncClient(timeout=120) as client:
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


async def call_claude(messages: list, system: str = "") -> str:
    """Appelle Claude API (claude-opus-4-6) avec adaptive thinking."""
    import anthropic
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY absent")
    client = anthropic.AsyncAnthropic(api_key=key)
    kwargs = {
        "model": CLAUDE_MODEL,
        "max_tokens": 4096,
        "messages": messages,
        "thinking": {"type": "adaptive"},
    }
    if system:
        kwargs["system"] = system
    response = await client.messages.create(**kwargs)
    # Extraire uniquement les blocs texte (ignorer les blocs thinking)
    return next((b.text for b in response.content if b.type == "text"), "")


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


async def call_openai(messages: list, system: str = "") -> str:
    """Fallback OpenAI — gpt-4o-mini par défaut."""
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("OPENAI_API_KEY absent dans .env")
    try:
        import openai
    except ImportError:
        raise RuntimeError("openai non installé — pip install openai")
    client = openai.AsyncOpenAI(api_key=key)
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.extend(messages)
    response = await client.chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        messages=msgs,
        max_tokens=2000,
        timeout=60,
    )
    return response.choices[0].message.content or ""


async def llm(role: str, messages: list, system: str = "") -> dict:
    """
    Routing LLM avec chaîne de fallback :
    strategist → Claude (claude-opus-4-6) → MLX → Ollama → Kimi → OpenAI
    autres rôles → Ollama → Kimi → OpenAI
    """
    model = MODELS.get(role, MODELS["worker"])

    # 1. Claude API — priorité absolue pour le stratège (meilleure qualité de planification)
    if role == "strategist" and claude_available():
        try:
            content = await call_claude(messages, system)
            return {"content": content, "provider": "claude", "model": CLAUDE_MODEL}
        except Exception as e:
            print(f"[Brain] Claude failed: {e} → MLX/Ollama")

    # 2. MLX — GPU local Apple Silicon (stratège uniquement)
    if role == "strategist" and mlx_available():
        try:
            content = await call_mlx(messages, system)
            return {"content": content, "provider": "mlx", "model": "qwen3-mlx"}
        except Exception as e:
            print(f"[Brain] MLX failed: {e} → Ollama")

    # 3. Ollama — LLM local par défaut
    last_error = ""
    try:
        content = await call_ollama(model, messages, system)
        return {"content": content, "provider": "ollama", "model": model}
    except Exception as e:
        last_error = f"Ollama: {e}"
        print(f"[Brain] Ollama failed: {e}")

    # 4. Kimi — cloud uniquement si la clé est présente
    if os.environ.get("KIMI_API_KEY"):
        try:
            content = await call_kimi(messages, system)
            return {"content": content, "provider": "kimi", "model": "moonshot-v1-8k"}
        except Exception as e_kimi:
            last_error = f"Kimi: {e_kimi}"
            print(f"[Brain] Kimi failed: {e_kimi}")

    # 5. OpenAI — fallback cloud secondaire
    if os.environ.get("OPENAI_API_KEY"):
        try:
            content = await call_openai(messages, system)
            return {"content": content, "provider": "openai", "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini")}
        except Exception as e_openai:
            last_error = f"OpenAI: {e_openai}"
            print(f"[Brain] OpenAI failed: {e_openai}")

    raise RuntimeError(f"Tous les providers LLM ont échoué. Dernier: {last_error}")


async def compress_context(messages: list) -> str:
    history = "\n".join([f"{m['role']}: {m['content']}" for m in messages])
    prompt = [{"role": "user", "content": f"Résume en moins de 400 tokens. Garde: décisions, erreurs, état actuel, prochaine étape. Supprime: répétitions, politesses.\n\n{history}"}]

    for attempt in range(3):
        try:
            result = await call_ollama(MODELS["compressor"], prompt)
            return result
        except Exception as e:
            if attempt < 2:
                print(f"[Brain] compress_context retry {attempt+1}: {e}")
                await asyncio.sleep(2 ** attempt)
            else:
                # Fallback: retourner une troncature simple
                print(f"[Brain] compress_context failed after 3 attempts: {e}")
                return history[-2000:]  # Garde les 2000 derniers chars


def load_domain_context(mission_type: str) -> str:
    ctx_file = ROOT / f"support/domain-contexts/{mission_type}.md"
    mem_file = ROOT / "agent/memory/persistent.md"
    ctx = ""
    if ctx_file.exists():
        ctx += ctx_file.read_text()
    if mem_file.exists():
        ctx += "\n\n" + mem_file.read_text()[-2000:]
    return ctx


def load_skills_list() -> str:
    """Charge les skills disponibles depuis registry.json pour guider la planification (C1)."""
    try:
        registry_path = ROOT / "skills/registry.json"
        if not registry_path.exists():
            return ""
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        skills = registry.get("skills", [])
        if not skills:
            return ""
        lines = ["Skills disponibles (tu peux les référencer dans tes sous-tâches):"]
        for s in skills[:20]:
            lines.append(f"  - {s['name']}: {s.get('description', '')[:80]}")
        return "\n".join(lines)
    except Exception:
        return ""


async def _async_load_domain_context(mission_type: str) -> str:
    try:
        return await asyncio.get_event_loop().run_in_executor(None, load_domain_context, mission_type)
    except Exception as e:
        print(f"[Brain] load_domain_context error: {e}")
        return ""


async def _async_load_skills_list() -> str:
    try:
        return await asyncio.get_event_loop().run_in_executor(None, load_skills_list)
    except Exception as e:
        print(f"[Brain] load_skills_list error: {e}")
        return ""


async def load_recent_learnings() -> str:
    """Charge les 3 derniers épisodes mémoire pour éviter de répéter les erreurs (C1)."""
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"http://localhost:{CONFIG['ports']['memory']}/episodes?limit=3")
            r.raise_for_status()
            episodes = r.json().get("episodes", [])
        if not episodes:
            return ""
        lines = ["Apprentissages récents (prends-les en compte):"]
        for ep in episodes:
            flag = "✓" if ep.get("success") else "✗"
            mission_short = ep.get("mission", "")[:70]
            result_short = ep.get("result", "")[:80]
            lines.append(f"  {flag} {mission_short} → {result_short}")
        return "\n".join(lines)
    except Exception:
        return ""


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

    # C1 — contexte enrichi : domain + skills + mémoire récente (en parallèle)
    domain_ctx, skills_ctx, learnings_ctx = await asyncio.gather(
        _async_load_domain_context(req.mission_type),
        _async_load_skills_list(),
        load_recent_learnings(),
        return_exceptions=True,
    )
    domain_ctx   = domain_ctx   if isinstance(domain_ctx, str)   else ""
    skills_ctx   = skills_ctx   if isinstance(skills_ctx, str)   else ""
    learnings_ctx = learnings_ctx if isinstance(learnings_ctx, str) else ""

    context_blocks = []
    if domain_ctx:
        context_blocks.append(f"### Contexte domaine\n{domain_ctx[:800]}")
    if skills_ctx:
        context_blocks.append(skills_ctx)
    if learnings_ctx:
        context_blocks.append(learnings_ctx)
    extra_context = "\n\n".join(context_blocks)

    system_prompt = f"""Tu es le cerveau de PICO-RUCHE (Ghost OS v5.0.0).
Tu analyses la mission et la décomposes en sous-tâches atomiques parallélisables.
Maximum {CONFIG['brain']['max_subtasks']} sous-tâches. Réponds UNIQUEMENT en JSON valide sans markdown.

## Format de réponse requis

{{
  "goal": "description concise de l'objectif",
  "subtasks": [
    {{
      "id": "1",
      "role": "shell|vision|worker|strategist",
      "instruction": "instruction précise et auto-suffisante",
      "risk": "low|medium|high",
      "confidence": 0.85,
      "depends_on": [],
      "rollback": "comment annuler si ça échoue"
    }}
  ],
  "reasoning": "pourquoi cette décomposition",
  "estimated_duration": "Xs",
  "parallelizable": true
}}

## Règles de décomposition

- **low**: action sûre et réversible (lecture, affichage, status)
- **medium**: modification système (écriture fichier, installation)
- **high**: suppression ou changement critique (rm, format, shutdown) → HITL obligatoire
- **confidence**: 0.0–1.0 (ta certitude que cette sous-tâche va réussir)
- **depends_on**: IDs des sous-tâches qui doivent terminer avant celle-ci ([] = parallélisable)
- **rollback**: étape concrète pour annuler si la sous-tâche échoue

## Rôles disponibles

- **shell**: commande terminal via executor sandboxé
- **vision**: capture + analyse visuelle de l'écran
- **worker**: tâche de réflexion/génération via LLM
- **strategist**: planification ou analyse complexe via LLM haute qualité
{f"{chr(10)}{extra_context}" if extra_context else ""}"""
    messages.append({"role": "user", "content": req.mission})
    result = await llm(req.role, messages, system_prompt)
    raw_content = result["content"].strip()
    # Extraire le JSON même si le LLM ajoute du texte avant/après
    json_match = None
    brace_start = raw_content.find("{")
    brace_end = raw_content.rfind("}")
    if brace_start != -1 and brace_end != -1:
        json_match = raw_content[brace_start:brace_end + 1]
    try:
        plan = json.loads(json_match or raw_content)
    except Exception:
        plan = {}
    # Garantir la structure minimale attendue
    if not isinstance(plan.get("subtasks"), list) or not plan["subtasks"]:
        plan["subtasks"] = [
            {"id": "1", "role": "worker", "instruction": req.mission, "risk": "medium"}
        ]
    if not plan.get("goal"):
        plan["goal"] = req.mission
    if not plan.get("reasoning"):
        plan["reasoning"] = raw_content if not json_match else plan.get("reasoning", "")
    if not plan.get("estimated_duration"):
        plan["estimated_duration"] = "?"
    # Valider chaque subtask
    valid_roles = {"shell", "vision", "worker", "strategist", "repair"}
    valid_risks = set(CONFIG["brain"]["risk_levels"])
    for st in plan["subtasks"]:
        if st.get("role") not in valid_roles:
            st["role"] = "worker"
        if st.get("risk") not in valid_risks:
            st["risk"] = "medium"
        if not st.get("id"):
            st["id"] = str(plan["subtasks"].index(st) + 1)
        if not st.get("instruction"):
            st["instruction"] = req.mission
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
    claude_ok = claude_available()
    active_provider = "claude" if claude_ok else ("mlx" if mlx_ok else "ollama")
    return {
        "status": "ok",
        "layer": "brain",
        "active_provider": active_provider,
        "providers": {
            "claude": claude_ok,
            "mlx": mlx_ok,
            "ollama": OLLAMA_URL,
            "kimi": bool(os.environ.get("KIMI_API_KEY")),
        },
        "models": MODELS,
        "claude_model": CLAUDE_MODEL if claude_ok else None,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["brain"])
