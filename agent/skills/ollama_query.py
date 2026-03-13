"""
Skill : ollama_query — Interface directe avec Ollama (localhost:11434)
Fonctions : query, list_models, model_info
"""
import httpx
from typing import Any

OLLAMA_BASE = "http://localhost:11434"
DEFAULT_TIMEOUT = 60.0


def query(model: str, prompt: str, options: dict | None = None) -> dict[str, Any]:
    """
    Envoie un prompt à un modèle Ollama et retourne la réponse complète.

    Args:
        model   : nom du modèle (ex: "llama3:latest", "llama3.2:3b")
        prompt  : texte du prompt
        options : paramètres Ollama optionnels (temperature, top_p, …)

    Returns:
        {
            "success": bool,
            "model": str,
            "response": str,
            "eval_count": int,      # tokens générés
            "eval_duration_ms": int
        }
    """
    if not model or not prompt:
        return {"success": False, "model": model, "response": "",
                "error": "model et prompt sont requis"}

    payload: dict[str, Any] = {
        "model":  model,
        "prompt": prompt,
        "stream": False,
    }
    if options:
        payload["options"] = options

    try:
        resp = httpx.post(
            f"{OLLAMA_BASE}/api/generate",
            json=payload,
            timeout=DEFAULT_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "success":         True,
            "model":           data.get("model", model),
            "response":        data.get("response", ""),
            "eval_count":      data.get("eval_count", 0),
            "eval_duration_ms": int(data.get("eval_duration", 0) / 1e6),
        }
    except httpx.HTTPStatusError as exc:
        return {"success": False, "model": model, "response": "",
                "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
    except Exception as exc:
        return {"success": False, "model": model, "response": "", "error": str(exc)}


def list_models() -> dict[str, Any]:
    """
    Retourne la liste des modèles disponibles localement.

    Returns:
        {
            "success": bool,
            "models": [{"name": str, "size_gb": float, "modified": str}, ...]
        }
    """
    try:
        resp = httpx.get(f"{OLLAMA_BASE}/api/tags", timeout=5.0)
        resp.raise_for_status()
        raw_models = resp.json().get("models", [])
        models = [
            {
                "name":       m.get("name", ""),
                "size_gb":    round(m.get("size", 0) / 1e9, 2),
                "modified":   m.get("modified_at", ""),
            }
            for m in raw_models
        ]
        return {"success": True, "models": models}
    except Exception as exc:
        return {"success": False, "models": [], "error": str(exc)}


def model_info(name: str) -> dict[str, Any]:
    """
    Retourne les détails d'un modèle Ollama spécifique.

    Args:
        name : nom du modèle (ex: "llama3:latest")

    Returns:
        {
            "success": bool,
            "name": str,
            "parameters": str,
            "template": str,
            "details": dict
        }
    """
    if not name:
        return {"success": False, "name": "", "error": "name est requis"}

    try:
        resp = httpx.post(
            f"{OLLAMA_BASE}/api/show",
            json={"name": name},
            timeout=5.0,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "success":    True,
            "name":       name,
            "parameters": data.get("parameters", ""),
            "template":   data.get("template", ""),
            "details":    data.get("details", {}),
        }
    except httpx.HTTPStatusError as exc:
        return {"success": False, "name": name,
                "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
    except Exception as exc:
        return {"success": False, "name": name, "error": str(exc)}


if __name__ == "__main__":
    import json
    print(json.dumps(list_models(), indent=2))
