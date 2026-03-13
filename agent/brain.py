"""
Couche cerveau — port 8003
Claude API · MLX · Ollama · routing modèles · compression contexte · planification
Provider : Claude API (claude-opus-4-6) · Fallback cloud : Kimi → OpenAI
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

# Circuit breaker : compte les échecs consécutifs par provider
_provider_failures: dict = {"claude": 0, "kimi": 0, "openai": 0, "ollama": 0, "mlx": 0}
_PROVIDER_MAX_FAILURES = 3   # après 3 échecs consécutifs, on skip ce provider
_circuit_reset_count: int = 0  # compteur de resets consécutifs pour backoff exponentiel


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
    """Estime les tokens — ajustement +25% pour le français (plus verbeux que l'anglais)."""
    # Règle empirique : 1 token ≈ 4 chars anglais ≈ 3.2 chars français
    # On prend le max entre char-based et word-based pour être conservateur
    char_est = len(text) // 4
    word_est = len(text.split()) * 1  # 1 token ≈ 1 mot anglais courant
    return max(char_est, word_est)


async def call_ollama(model: str, messages: list, system: str = "", force_json: bool = False) -> str:
    """Appelle Ollama. force_json=True active format='json' pour éviter le texte conversationnel."""
    payload = {"model": model, "messages": messages, "stream": False}
    if system:
        payload["messages"] = [{"role": "system", "content": system}] + messages
    if force_json:
        payload["format"] = "json"
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
    text = next((b.text for b in response.content if b.type == "text"), "")
    if not text.strip():
        raise ValueError("Claude a retourné une réponse vide (aucun bloc texte)")
    return text


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
    Routing LLM avec circuit breaker par provider.
    Claude API prioritaire — Kimi → OpenAI en fallback.
    Un provider est mis en pause après _PROVIDER_MAX_FAILURES échecs consécutifs.
    """
    global _circuit_reset_count

    providers_tried = 0

    # 1. Claude API — pour tous les rôles
    if claude_available() and _provider_failures.get("claude", 0) < _PROVIDER_MAX_FAILURES:
        print(f"[Brain] 🔄 Tentative provider: claude (failures: {_provider_failures.get('claude', 0)})")
        try:
            content = await call_claude(messages, system)
            _provider_failures["claude"] = 0   # reset on success
            _circuit_reset_count = 0            # reset du backoff après succès
            return {"content": content, "provider": "claude", "model": CLAUDE_MODEL}
        except Exception as e:
            _provider_failures["claude"] = _provider_failures.get("claude", 0) + 1
            print(f"[Brain] Claude failed ({_provider_failures['claude']}/{_PROVIDER_MAX_FAILURES}): {e}")
            providers_tried += 1

    # 2. Kimi — fallback cloud
    if os.environ.get("KIMI_API_KEY") and _provider_failures.get("kimi", 0) < _PROVIDER_MAX_FAILURES:
        print(f"[Brain] 🔄 Tentative provider: kimi (failures: {_provider_failures.get('kimi', 0)})")
        try:
            content = await call_kimi(messages, system)
            _provider_failures["kimi"] = 0
            _circuit_reset_count = 0
            if providers_tried > 0:
                print(f"[Brain] ✅ Fallback kimi réussi après {providers_tried} tentative(s)")
            return {"content": content, "provider": "kimi", "model": "moonshot-v1-8k"}
        except Exception as e:
            _provider_failures["kimi"] = _provider_failures.get("kimi", 0) + 1
            print(f"[Brain] Kimi failed ({_provider_failures['kimi']}/{_PROVIDER_MAX_FAILURES}): {e}")
            providers_tried += 1

    # 3. OpenAI — fallback cloud secondaire
    if os.environ.get("OPENAI_API_KEY") and _provider_failures.get("openai", 0) < _PROVIDER_MAX_FAILURES:
        print(f"[Brain] 🔄 Tentative provider: openai (failures: {_provider_failures.get('openai', 0)})")
        try:
            content = await call_openai(messages, system)
            _provider_failures["openai"] = 0
            _circuit_reset_count = 0
            if providers_tried > 0:
                print(f"[Brain] ✅ Fallback openai réussi après {providers_tried} tentative(s)")
            return {"content": content, "provider": "openai", "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini")}
        except Exception as e:
            _provider_failures["openai"] = _provider_failures.get("openai", 0) + 1
            print(f"[Brain] OpenAI failed ({_provider_failures['openai']}/{_PROVIDER_MAX_FAILURES}): {e}")
            providers_tried += 1

    # Reset circuit breakers si tous ont échoué — avec backoff exponentiel pour éviter la boucle infinie
    if all(v >= _PROVIDER_MAX_FAILURES for v in _provider_failures.values() if v > 0):
        # Backoff : 1er reset immédiat, 2ème → 5s, 3ème+ → 30s
        if _circuit_reset_count == 1:
            print("[Brain] ⚠️  Tous les circuit breakers ouverts — backoff 5s avant reset")
            await asyncio.sleep(5)
        elif _circuit_reset_count >= 2:
            print(f"[Brain] ⚠️  Tous les circuit breakers ouverts — backoff 30s avant reset (reset #{_circuit_reset_count + 1})")
            await asyncio.sleep(30)
        else:
            print("[Brain] ⚠️  Tous les circuit breakers ouverts — reset immédiat")
        _circuit_reset_count += 1
        for k in _provider_failures:
            _provider_failures[k] = 0

    raise RuntimeError("Tous les providers cloud ont échoué — vérifier ANTHROPIC_API_KEY dans .env")


async def compress_context(messages: list) -> str:
    history = "\n".join([f"{m['role']}: {m['content']}" for m in messages])
    prompt = [{"role": "user", "content": f"Résume en moins de 400 tokens. Garde: décisions, erreurs, état actuel, prochaine étape. Supprime: répétitions, politesses.\n\n{history}"}]

    try:
        result_dict = await llm("worker", prompt)
        return result_dict["content"]
    except Exception as e:
        print(f"[Brain] compress_context failed: {e}")
        return history[-2000:]


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
        async with httpx.AsyncClient(timeout=8) as c:
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
    except Exception as e:
        print(f"[Brain] load_recent_learnings error (couche memory indisponible): {e}")
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
      "instruction": "description humaine de la tâche",
      "command": "UNIQUEMENT pour role=shell : la commande bash exacte, ex: ls -la",
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
  ⚠️ IMPORTANT : pour role=shell, "instruction" doit être LA COMMANDE BASH EXACTE à exécuter,
  PAS une description en langage naturel. Exemples corrects :
  ✅ "ls -la"  ✅ "cat /etc/hosts"  ✅ "python3 script.py"
  ❌ "Exécuter la commande ls -la"  ❌ "Lister les fichiers"
- **vision**: capture + analyse visuelle de l'écran
- **worker**: tâche de réflexion/génération via LLM (instruction = prompt en langage naturel)
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
        "circuit_breakers": {k: {"failures": v, "open": v >= _PROVIDER_MAX_FAILURES} for k, v in _provider_failures.items()},
        "circuit_reset_count": _circuit_reset_count,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["brain"])
