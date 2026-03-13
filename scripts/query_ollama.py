#!/usr/bin/env python3
"""
query_ollama.py — Architecte de Ruche — Bridge de requête vers Ollama
Envoie des questions stratégiques au modèle ghost-os-architect.

Usage:
    python scripts/query_ollama.py "Quel est l'état de la ruche ?"
    python scripts/query_ollama.py                          # mode interactif
    python scripts/query_ollama.py --model llama3:latest    # modèle alternatif
    python scripts/query_ollama.py --json                   # sortie JSON brute
"""

import sys
import json
import httpx
import argparse
from datetime import datetime

OLLAMA_HOST = "http://localhost:11434"
DEFAULT_MODEL = "ghost-os-architect"
FALLBACK_MODEL = "llama3:latest"


def stream_response(prompt: str, model: str, context_file: str | None = None) -> str:
    """Envoie un prompt à Ollama et affiche la réponse en streaming."""
    # Prépare le contexte si fourni
    system_ctx = ""
    if context_file:
        try:
            from pathlib import Path
            system_ctx = Path(context_file).read_text(encoding="utf-8")[:8000]
        except Exception:
            pass

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": True,
        "options": {
            "temperature": 0.3,
            "top_p": 0.9,
            "num_predict": 2048,
        }
    }
    if system_ctx:
        payload["system"] = system_ctx

    full_response = []
    ts_start = datetime.now()

    print(f"\n🤖 [{model}] — {ts_start.strftime('%H:%M:%S')}")
    print("─" * 60)

    try:
        with httpx.stream("POST", f"{OLLAMA_HOST}/api/generate",
                          json=payload, timeout=120.0) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                try:
                    chunk = json.loads(line)
                    token = chunk.get("response", "")
                    if token:
                        print(token, end="", flush=True)
                        full_response.append(token)
                    if chunk.get("done"):
                        break
                except json.JSONDecodeError:
                    continue

    except httpx.ConnectError:
        print(f"\n❌ Impossible de joindre Ollama sur {OLLAMA_HOST}")
        print("   Lance Ollama avec : ollama serve")
        sys.exit(1)
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            print(f"\n❌ Modèle '{model}' introuvable.")
            print(f"   Crée-le avec : ollama create {model} -f ./Modelfile")
            print(f"   Ou utilise le fallback : python scripts/query_ollama.py --model {FALLBACK_MODEL} ...")
        else:
            print(f"\n❌ Erreur HTTP {e.response.status_code}: {e.response.text[:200]}")
        sys.exit(1)

    elapsed = (datetime.now() - ts_start).total_seconds()
    full_text = "".join(full_response)

    print(f"\n─ ─ ─\n⏱  {elapsed:.1f}s — {len(full_text)} chars\n")
    return full_text


def check_model_exists(model: str) -> bool:
    """Vérifie si le modèle est disponible dans Ollama."""
    try:
        r = httpx.get(f"{OLLAMA_HOST}/api/tags", timeout=5.0)
        models = [m["name"] for m in r.json().get("models", [])]
        return any(m.split(":")[0] == model.split(":")[0] for m in models)
    except Exception:
        return False


def interactive_mode(model: str, context_file: str | None):
    """Mode REPL interactif."""
    print(f"\n🏰 Ghost OS Architecte de Ruche — mode interactif")
    print(f"   Modèle : {model}")
    print("   Tape 'exit' ou Ctrl+C pour quitter\n")

    history: list[str] = []
    while True:
        try:
            question = input("❓ > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n\nAu revoir !")
            break

        if not question or question.lower() in ("exit", "quit", "q"):
            break

        history.append(question)
        # On enrichit le prompt avec l'historique court
        ctx_prompt = question
        if len(history) > 1:
            ctx_prompt = f"[Historique : {'; '.join(history[-3:-1])}]\n\nQuestion actuelle : {question}"

        stream_response(ctx_prompt, model, context_file)


def main():
    parser = argparse.ArgumentParser(
        description="Requête vers le modèle Ghost OS Architecte dans Ollama"
    )
    parser.add_argument("question", nargs="?", help="Question à poser (optionnel, sinon mode interactif)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Modèle Ollama (défaut: {DEFAULT_MODEL})")
    parser.add_argument("--context", default=None, help="Fichier de contexte à injecter (.md)")
    parser.add_argument("--json", action="store_true", help="Affiche la réponse JSON brute")
    args = parser.parse_args()

    # Vérifie que le modèle existe — sinon fallback
    model = args.model
    if not check_model_exists(model):
        if model == DEFAULT_MODEL:
            print(f"⚠️  Modèle '{DEFAULT_MODEL}' non trouvé — fallback sur '{FALLBACK_MODEL}'")
            print(f"   Pour créer le modèle dédié : ollama create {DEFAULT_MODEL} -f ./Modelfile\n")
            model = FALLBACK_MODEL
            if not check_model_exists(model):
                print(f"❌ Modèle fallback '{FALLBACK_MODEL}' également absent.")
                print("   Modèles disponibles :")
                try:
                    r = httpx.get(f"{OLLAMA_HOST}/api/tags", timeout=5.0)
                    for m in r.json().get("models", []):
                        print(f"   - {m['name']}")
                except Exception:
                    print("   (impossible de lister les modèles)")
                sys.exit(1)

    if args.question:
        stream_response(args.question, model, args.context)
    else:
        interactive_mode(model, args.context)


if __name__ == "__main__":
    main()
