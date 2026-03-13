#!/usr/bin/env python3
"""
dream_cycle.py — Consolidation sémantique des épisodes en règles heuristiques
Ghost OS v7 — Lance toutes les heures via cron ou manuellement

Usage:
    python3 scripts/dream_cycle.py
    python3 scripts/dream_cycle.py --verbose
    python3 scripts/dream_cycle.py --limit 10  # analyse seulement les 10 derniers
"""

import sys
import json
import argparse
import httpx
from pathlib import Path
from datetime import datetime

# ─── Chemins ─────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
EPISODES_FILE = ROOT / "agent" / "memory" / "episodes.jsonl"
HEURISTICS_FILE = ROOT / "agent" / "memory" / "heuristics.jsonl"

# ─── Config Ollama ────────────────────────────────────────────────────────────
OLLAMA_HOST = "http://localhost:11434"
OLLAMA_MODEL = "llama3.2:3b"
OLLAMA_TIMEOUT = httpx.Timeout(connect=3.0, read=120.0, write=10.0, pool=5.0)

# ─── Paramètres du cycle ─────────────────────────────────────────────────────
DEFAULT_LIMIT = 20   # nombre d'épisodes à analyser
BATCH_SIZE = 5       # taille d'un batch envoyé à Ollama


def load_episodes(limit: int) -> list[dict]:
    """Lit les `limit` derniers épisodes depuis episodes.jsonl."""
    if not EPISODES_FILE.exists():
        return []

    episodes = []
    with EPISODES_FILE.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                episodes.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # ligne corrompue → skip silencieux

    # Retourne les `limit` derniers (ordre chronologique préservé)
    return episodes[-limit:]


def load_existing_heuristics() -> set[str]:
    """
    Charge les heuristiques déjà connues pour la déduplication.
    Retourne un set de clés de déduplication : "when||then" (minuscule).
    """
    keys = set()
    if not HEURISTICS_FILE.exists():
        return keys

    with HEURISTICS_FILE.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                h = json.loads(line)
                key = f"{h.get('when', '').lower().strip()}||{h.get('then', '').lower().strip()}"
                keys.add(key)
            except json.JSONDecodeError:
                continue
    return keys


def format_episodes_for_prompt(episodes: list[dict]) -> str:
    """Formate une liste d'épisodes en texte lisible pour le prompt."""
    lines = []
    for i, ep in enumerate(episodes, 1):
        mission = ep.get("mission", "(sans mission)")
        success = "OK" if ep.get("success") else "ECHEC"
        model = ep.get("model_used", "?")
        duration = ep.get("duration_ms", 0)
        # Tronque la mission pour ne pas dépasser la fenêtre de contexte
        if len(mission) > 300:
            mission = mission[:300] + "..."
        lines.append(f"{i}. [{success}] ({model}, {duration}ms) {mission}")
    return "\n".join(lines)


def build_prompt(episodes: list[dict]) -> str:
    """Construit le prompt d'extraction envoyé à Ollama."""
    episodes_text = format_episodes_for_prompt(episodes)
    return f"""Tu es un système d'apprentissage. Voici des missions récentes d'un agent IA.
Pour chaque pattern que tu identifies, génère une règle heuristique.

Missions:
{episodes_text}

Réponds UNIQUEMENT avec un JSON array de règles:
[
  {{"when": "l'utilisateur demande de la musique", "then": "ouvrir Spotify puis jouer", "confidence": 0.9, "source": "episodes"}},
  {{"when": "une URL YouTube est mentionnée", "then": "goto_url directement sans passer par search", "confidence": 0.8, "source": "episodes"}}
]
Réponds UNIQUEMENT avec le JSON, sans texte avant ni après."""


def call_ollama(prompt: str) -> str | None:
    """
    Envoie un prompt à Ollama (mode non-streaming) et retourne la réponse brute.
    Retourne None si Ollama est inaccessible ou retourne une erreur.
    """
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": 0.2,   # faible pour des règles cohérentes
            "top_p": 0.9,
            "num_predict": 1024,
        },
    }
    try:
        response = httpx.post(
            f"{OLLAMA_HOST}/api/generate",
            json=payload,
            timeout=OLLAMA_TIMEOUT,
        )
        response.raise_for_status()
        data = response.json()
        return data.get("response", "").strip()

    except httpx.ConnectError:
        print(f"  [WARN] Ollama inaccessible sur {OLLAMA_HOST} — batch ignoré", file=sys.stderr)
    except httpx.TimeoutException:
        print(f"  [WARN] Timeout Ollama ({OLLAMA_TIMEOUT}s) — batch ignoré", file=sys.stderr)
    except httpx.HTTPStatusError as exc:
        print(f"  [WARN] HTTP {exc.response.status_code} depuis Ollama — batch ignoré", file=sys.stderr)
    except Exception as exc:
        print(f"  [WARN] Erreur inattendue Ollama : {exc} — batch ignoré", file=sys.stderr)

    return None


def parse_rules(raw_response: str) -> list[dict]:
    """
    Parse la réponse brute d'Ollama pour extraire le JSON array de règles.
    Robuste : cherche le premier '[' et le dernier ']'.
    """
    if not raw_response:
        return []

    # Cherche les délimiteurs du tableau JSON
    start = raw_response.find("[")
    end = raw_response.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []

    json_fragment = raw_response[start : end + 1]
    try:
        rules = json.loads(json_fragment)
        if not isinstance(rules, list):
            return []
        # Valide que chaque règle a les champs minimum
        valid = []
        for r in rules:
            if isinstance(r, dict) and r.get("when") and r.get("then"):
                valid.append(r)
        return valid
    except json.JSONDecodeError:
        return []


def dedup_key(rule: dict) -> str:
    """Clé de déduplication pour une règle."""
    return f"{rule.get('when', '').lower().strip()}||{rule.get('then', '').lower().strip()}"


def save_heuristics(new_rules: list[dict]) -> None:
    """Ajoute les nouvelles règles à heuristics.jsonl (mode append)."""
    HEURISTICS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with HEURISTICS_FILE.open("a", encoding="utf-8") as fh:
        for rule in new_rules:
            fh.write(json.dumps(rule, ensure_ascii=False) + "\n")


def run_dream_cycle(limit: int, verbose: bool) -> int:
    """
    Boucle principale du cycle du rêve.
    Retourne le nombre de nouvelles règles extraites.
    """
    # ── 1. Chargement des épisodes ────────────────────────────────────────────
    print(f"[dream_cycle] Chargement des {limit} derniers épisodes…")
    episodes = load_episodes(limit)

    if not episodes:
        print("[dream_cycle] Aucun épisode trouvé — arrêt.", file=sys.stderr)
        return -1  # signal d'échec : aucun épisode

    print(f"[dream_cycle] {len(episodes)} épisodes chargés.")

    # ── 2. Chargement des heuristiques existantes (déduplication) ────────────
    existing_keys = load_existing_heuristics()
    print(f"[dream_cycle] {len(existing_keys)} heuristiques déjà connues.")

    # ── 3. Traitement par batches ─────────────────────────────────────────────
    all_new_rules: list[dict] = []
    duplicates_count = 0
    now_iso = datetime.now().isoformat(timespec="seconds")

    batches = [episodes[i : i + BATCH_SIZE] for i in range(0, len(episodes), BATCH_SIZE)]
    print(f"[dream_cycle] {len(batches)} batch(es) de {BATCH_SIZE} épisodes à traiter.")

    for batch_idx, batch in enumerate(batches, 1):
        print(f"\n[dream_cycle] Batch {batch_idx}/{len(batches)} ({len(batch)} épisodes)…")

        prompt = build_prompt(batch)
        raw = call_ollama(prompt)

        if raw is None:
            # Ollama inaccessible ou erreur — skip ce batch, les autres continuent
            print(f"  Batch {batch_idx} ignoré (Ollama indisponible).")
            continue

        rules = parse_rules(raw)
        print(f"  {len(rules)} règle(s) extraite(s) par Ollama.")

        for rule in rules:
            key = dedup_key(rule)
            if key in existing_keys:
                duplicates_count += 1
                if verbose:
                    print(f"  [dup] QUAND {rule['when']!r} ALORS {rule['then']!r}")
                continue

            # Règle nouvelle : on l'enrichit avec les métadonnées du cycle
            enriched = {
                "when": rule["when"],
                "then": rule["then"],
                "confidence": rule.get("confidence", 0.5),
                "extracted_at": now_iso,
                "episode_count": len(batch),
                "source": "dream_cycle",
            }
            all_new_rules.append(enriched)
            existing_keys.add(key)  # évite les doublons intra-cycle

            if verbose:
                conf = enriched["confidence"]
                print(f"  [NEW conf={conf:.2f}] QUAND {enriched['when']!r} ALORS {enriched['then']!r}")

    # ── 4. Sauvegarde ─────────────────────────────────────────────────────────
    if all_new_rules:
        save_heuristics(all_new_rules)
        print(f"\n[dream_cycle] {len(all_new_rules)} règle(s) sauvegardée(s) dans {HEURISTICS_FILE}")
    else:
        print("\n[dream_cycle] Aucune nouvelle règle à sauvegarder.")

    return len(all_new_rules), duplicates_count


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cycle du rêve — extrait des règles heuristiques depuis les épisodes de mémoire"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Affiche chaque règle extraite avec sa confidence",
    )
    parser.add_argument(
        "--limit", "-l",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"Nombre d'épisodes à analyser (défaut : {DEFAULT_LIMIT})",
    )
    args = parser.parse_args()

    result = run_dream_cycle(limit=args.limit, verbose=args.verbose)

    # run_dream_cycle retourne -1 si aucun épisode trouvé
    if result == -1:
        print("Cycle du rêve avorté — aucun épisode disponible.", file=sys.stderr)
        sys.exit(1)

    new_count, dup_count = result
    print(
        f"\nCycle du rêve terminé — {new_count} nouvelles règles extraites "
        f"({dup_count} dupliquées ignorées)"
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
