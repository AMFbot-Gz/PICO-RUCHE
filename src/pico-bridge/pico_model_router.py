"""
core/model_router.py — Routing intelligent multi-modèles

Analyse chaque tâche et route vers le modèle optimal :
  simple   → llama3.2:3b   (rapide, local)
  vision   → llava          (ou llama3.2-vision)
  code     → qwen3-coder    (ou llama3.2)
  complex  → llama3.2       (ou cloud)
  critical → Claude API     (meilleur raisonnement)
"""

import logging
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import requests
from dotenv import load_dotenv

BASE_DIR_ROUTER = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR_ROUTER))
from core.utils import TIMEOUTS

BASE_DIR = Path(__file__).parent.parent
load_dotenv(BASE_DIR / ".env")

ACTIONS_LOG = BASE_DIR / "memory" / "actions.log"

# ─── Registre des modèles ─────────────────────────────────────────────────────

MODEL_REGISTRY: dict[str, dict] = {
    # ── Locaux Ollama ──────────────────────────────────────────────────────────
    "llama3.2:3b": {
        "ollama_name":  "llama3.2:3b",
        "strengths":    ["tâches simples", "instructions courtes", "rapide", "français"],
        "max_complexity": "simple",
        "speed":        "fast",
        "cost":         0,
    },
    "llama3": {
        "ollama_name":  "llama3:latest",
        "strengths":    ["raisonnement", "instructions", "français", "planification"],
        "max_complexity": "medium",
        "speed":        "medium",
        "cost":         0,
    },
    "llama3.2": {
        "ollama_name":  "llama3.2:latest",
        "strengths":    ["raisonnement complexe", "multi-étapes", "analyse", "planification"],
        "max_complexity": "complex",
        "speed":        "medium",
        "cost":         0,
    },
    "llava": {
        "ollama_name":  "llava:latest",
        "strengths":    ["vision", "analyse écran", "coordonnées", "description visuelle"],
        "max_complexity": "medium",
        "speed":        "medium",
        "cost":         0,
    },
    "llama3.2-vision": {
        "ollama_name":  "llama3.2-vision:latest",
        "strengths":    ["vision avancée", "raisonnement visuel", "OCR", "UI complexe"],
        "max_complexity": "complex",
        "speed":        "medium",
        "cost":         0,
    },
    "moondream": {
        "ollama_name":  "moondream:latest",
        "strengths":    ["vision rapide", "description image", "détection UI"],
        "max_complexity": "simple",
        "speed":        "fast",
        "cost":         0,
    },
    # ── Cloud via Ollama ───────────────────────────────────────────────────────
    "qwen3-coder": {
        "ollama_name":  "qwen3-coder:480b-cloud",
        "strengths":    ["génération code", "debug", "scripts Python", "skill generation"],
        "max_complexity": "complex",
        "speed":        "medium",
        "cost":         0,
    },
    "llm-cloud-powerful": {
        "ollama_name":  "gpt-oss:120b-cloud",
        "strengths":    ["raisonnement avancé", "planification complexe", "multi-étapes"],
        "max_complexity": "complex",
        "speed":        "medium",
        "cost":         0,
    },
    # ── Claude API ────────────────────────────────────────────────────────────
    "claude": {
        "api":          "anthropic",
        "model_id":     os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5"),
        "strengths":    ["tâches critiques", "raisonnement profond", "code complexe",
                         "auto-évolution", "analyse multi-fichiers"],
        "max_complexity": "critical",
        "speed":        "medium",
        "cost":         0.003,
    },
}


# ─── DataClass profil de tâche ────────────────────────────────────────────────

@dataclass
class TaskProfile:
    complexity:           str    # "simple" | "medium" | "complex" | "critical"
    type:                 str    # "vision" | "code" | "action" | "reasoning" | "creative"
    requires_vision:      bool
    requires_code:        bool
    estimated_steps:      int
    confidence_required:  float  # 0.0 – 1.0
    selected_model:       str    = ""
    routing_reason:       str    = ""


# ─── Classe ModelRouter ───────────────────────────────────────────────────────

class ModelRouter:

    def __init__(self):
        self.ollama_url    = os.getenv("OLLAMA_URL", "http://localhost:11434")
        self.routing_mode  = os.getenv("ROUTING_MODE", "auto")
        self.anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")
        self.available_models: list[str] = []
        self._detect_models()

    # ─── Détection des modèles disponibles ────────────────────────────────────

    def _detect_models(self) -> None:
        """Interroge Ollama et stocke les modèles installés."""
        try:
            resp = requests.get(f"{self.ollama_url}/api/tags", timeout=5)
            resp.raise_for_status()
            ollama_names = {m["name"] for m in resp.json().get("models", [])}

            # Mappe les noms Ollama vers les clés du registre
            for key, info in MODEL_REGISTRY.items():
                if info.get("api") == "anthropic":
                    if self.anthropic_key:
                        self.available_models.append(key)
                elif info.get("ollama_name", "") in ollama_names:
                    self.available_models.append(key)

        except Exception:
            # Ollama inaccessible — garde les modèles cloud si clé présente
            if self.anthropic_key:
                self.available_models = ["claude"]

        print(f"🧭 Router initialisé — modèles disponibles : {self.available_models}")

    def _has(self, model: str) -> bool:
        return model in self.available_models

    # ─── Analyse de la tâche ─────────────────────────────────────────────────

    def analyze_task(self, task: str) -> TaskProfile:
        """Analyse la requête et retourne un TaskProfile complet."""
        tl = task.lower()

        # ── Vision ────────────────────────────────────────────────────────────
        vision_kws = ["vois", "regarde", "écran", "ecran", "capture",
                      "screenshot", "image", "clique sur", "trouve le bouton",
                      "où est", "ou est", "position de", "bouton", "fenetre",
                      "fenêtre", "icone", "icône"]
        requires_vision = any(kw in tl for kw in vision_kws)

        # ── Code ──────────────────────────────────────────────────────────────
        code_kws = ["code", "script", "python", "programme", "fonction",
                    "debug", "erreur", "installe", "pip", "import",
                    "def ", "class ", "génère un skill", "répare le code"]
        requires_code = any(kw in tl for kw in code_kws)

        # ── Complexité ────────────────────────────────────────────────────────
        step_kws        = ["puis", "ensuite", "après", "apres", "enfin", "d'abord",
                           "dabord", "finalement", "premièrement", "deuxièmement"]
        # Compte les occurrences totales (pas juste la présence)
        estimated_steps = 1 + sum(tl.count(kw) for kw in step_kws)
        word_count      = len(task.split())

        critical_kws = ["répare toi", "repare toi", "évolue", "evolue",
                        "analyse tout", "auto-améliore", "auto améliore",
                        "génère un skill complexe", "stratégie globale",
                        "planifie la semaine", "self_evolve"]

        if any(kw in tl for kw in critical_kws):
            complexity = "critical"
        elif estimated_steps >= 4 or word_count >= 25:
            complexity = "complex"
        elif estimated_steps >= 3 or word_count >= 12 or requires_code:
            complexity = "medium"
        else:
            complexity = "simple"

        # ── Web (Playwright DOM direct — pas besoin de vision) ───────────────────
        web_kws = ["site", "web", "url", "http", "google", "recherche",
                   "navigue", "formulaire", "connecte", "login", "scrape",
                   "extrait", "télécharge", "cherche en ligne", "bing",
                   "duckduckgo", "wikipedia", "amazon", ".com", ".fr", ".org"]
        requires_browser = any(kw in tl for kw in web_kws)

        # ── Type ──────────────────────────────────────────────────────────────
        if requires_browser:
            task_type      = "web"
            requires_vision = False  # DOM direct, pas besoin de LLaVA
        elif requires_vision:
            task_type = "vision"
        elif requires_code:
            task_type = "code"
        elif complexity in ("complex", "critical"):
            task_type = "reasoning"
        else:
            task_type = "action"

        # ── Confiance requise ─────────────────────────────────────────────────
        if any(kw in tl for kw in ["exactement", "précisément", "precisement"]):
            confidence = 0.95
        elif any(kw in tl for kw in ["essaie", "tente", "peut-être"]):
            confidence = 0.6
        else:
            confidence = 0.8

        return TaskProfile(
            complexity          = complexity,
            type                = task_type,
            requires_vision     = requires_vision,
            requires_code       = requires_code,
            estimated_steps     = estimated_steps,
            confidence_required = confidence,
        )

    # ─── Sélection du modèle ─────────────────────────────────────────────────

    def select_model(self, profile: TaskProfile) -> str:
        """Retourne le nom du modèle optimal selon le profil et le mode."""
        fallback = self._ollama_fallback()
        mode     = self.routing_mode

        if mode == "claude_only":
            model  = "claude"
            reason = "mode claude_only forcé"

        elif mode == "local_only":
            model, reason = self._select_local(profile, fallback)

        else:  # auto
            model, reason = self._select_auto(profile, fallback)

        # Vérification finale de disponibilité
        if model not in self.available_models:
            reason += f" → fallback {fallback} ({model} non disponible)"
            model   = fallback

        profile.selected_model = model
        profile.routing_reason = reason
        return model

    def _select_local(self, profile: TaskProfile, fallback: str) -> tuple[str, str]:
        if profile.requires_vision:
            m = "llava" if self._has("llava") else fallback
            return m, "local: vision → llava"
        if profile.requires_code:
            m = "qwen3-coder" if self._has("qwen3-coder") else fallback
            return m, "local: code → qwen3-coder"
        if profile.complexity == "complex":
            m = "llama3.2" if self._has("llama3.2") else fallback
            return m, "local: complex → llama3.2"
        m = "llama3.2:3b" if self._has("llama3.2:3b") else fallback
        return m, "local: simple → llama3.2:3b"

    def _select_auto(self, profile: TaskProfile, fallback: str) -> tuple[str, str]:
        c = profile.complexity

        # Web : DOM direct → mistral suffit, pas besoin de vision
        if profile.type == "web":
            m = "llama3.2:3b" if self._has("llama3.2:3b") else "llama3" if self._has("llama3") else fallback
            return m, "auto: web → llama3.2:3b (DOM direct)"

        if c == "critical":
            m = "claude" if self._has("claude") else "llm-cloud-powerful" if self._has("llm-cloud-powerful") else fallback
            return m, "auto: critique → claude"

        if c == "complex" and profile.requires_vision:
            m = "llama3.2-vision" if self._has("llama3.2-vision") else "claude" if self._has("claude") else "llava" if self._has("llava") else fallback
            return m, "auto: complexe+vision → llama3.2-vision"

        if c == "complex" and profile.requires_code:
            m = "qwen3-coder" if self._has("qwen3-coder") else "claude" if self._has("claude") else fallback
            return m, "auto: complexe+code → qwen3-coder"

        if c == "complex":
            m = "llama3.2" if self._has("llama3.2") else "llm-cloud-powerful" if self._has("llm-cloud-powerful") else "claude" if self._has("claude") else fallback
            return m, "auto: complexe → llama3.2"

        if profile.requires_vision:
            m = "llava" if self._has("llava") else "moondream" if self._has("moondream") else fallback
            return m, "auto: vision → llava"

        if profile.requires_code:
            m = "qwen3-coder" if self._has("qwen3-coder") else "llama3.2:3b" if self._has("llama3.2:3b") else fallback
            return m, "auto: code → qwen3-coder"

        # Simple / medium
        m = "llama3.2:3b" if self._has("llama3.2:3b") else "llama3" if self._has("llama3") else fallback
        return m, f"auto: {c} → llama3.2:3b"

    def _ollama_fallback(self) -> str:
        """Retourne le premier modèle Ollama disponible comme fallback."""
        for m in ("llama3.2:3b", "llama3", "llama3.2", "llava"):
            if self._has(m):
                return m
        # Dernier recours : premier modèle disponible
        local = [m for m in self.available_models if MODEL_REGISTRY.get(m, {}).get("api") != "anthropic"]
        return local[0] if local else os.getenv("OLLAMA_MODEL", "llava")

    # ─── Appel du modèle ─────────────────────────────────────────────────────

    def call_model(self, model: str, prompt: str, system: str = "") -> str:
        """Route l'appel vers Anthropic ou Ollama selon le modèle."""
        t0 = time.time()

        if model == "claude" and self.anthropic_key:
            result = self._call_claude(prompt, system)
        else:
            # Résolution du nom Ollama
            ollama_name = MODEL_REGISTRY.get(model, {}).get("ollama_name", model)
            result      = self._call_ollama(ollama_name, prompt, system)

        duration = time.time() - t0
        self._log(f"call_model:{model}", len(prompt), len(result), duration)
        print(f"🤖 [{model}] {len(prompt)} chars → {len(result)} chars ({duration:.1f}s)")
        return result

    def _call_claude(self, prompt: str, system: str) -> str:
        model_id = MODEL_REGISTRY["claude"]["model_id"]
        for attempt in range(2):
            try:
                import anthropic
                client = anthropic.Anthropic(api_key=self.anthropic_key)
                kwargs: dict = {"model": model_id, "max_tokens": 2048,
                                "messages": [{"role": "user", "content": prompt}]}
                if system:
                    kwargs["system"] = system
                resp = client.messages.create(**kwargs)
                return resp.content[0].text
            except Exception as e:
                if attempt == 0:
                    time.sleep(2)
                    continue
                return f"[Claude erreur] {e}"
        return "[Claude timeout]"

    def _call_ollama(self, ollama_model: str, prompt: str, system: str) -> str:
        full_prompt = f"{system}\n\n{prompt}" if system else prompt
        for attempt in range(2):
            try:
                resp = requests.post(
                    f"{self.ollama_url}/api/generate",
                    json={
                        "model":   ollama_model,
                        "prompt":  full_prompt,
                        "stream":  False,
                        "options": {"temperature": 0.3, "num_predict": 1024},
                    },
                    timeout=TIMEOUTS["medium"],
                )
                resp.raise_for_status()
                return resp.json().get("response", "")
            except requests.exceptions.Timeout:
                logging.warning(f"_call_ollama [{ollama_model}] timeout (tentative {attempt+1})")
                if attempt == 0:
                    continue
                return f"[Timeout Ollama {ollama_model}]"
            except Exception as e:
                logging.warning(f"_call_ollama [{ollama_model}] erreur : {e}")
                if attempt == 0:
                    time.sleep(2)
                    continue
                return f"[Erreur Ollama {ollama_model}] {e}"
        return "[Ollama indisponible]"

    # ─── Helper log ──────────────────────────────────────────────────────────

    def _log(self, action: str, in_chars: int, out_chars: int, duration: float) -> None:
        import json
        from datetime import datetime
        ACTIONS_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(ACTIONS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "timestamp": datetime.now().isoformat(),
                "module":    "core/model_router",
                "action":    action,
                "in_chars":  in_chars,
                "out_chars": out_chars,
                "duration":  round(duration, 2),
            }, ensure_ascii=False) + "\n")
