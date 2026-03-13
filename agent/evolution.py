"""
Couche évolution — port 8005
Self-repair · génération skills · analyse patterns · amélioration continue
"""
import json
import os
import subprocess
import asyncio
import httpx
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import yaml
from dotenv import load_dotenv
from contextlib import asynccontextmanager
load_dotenv()

# FIX 1 — Locks par nom de skill pour éviter les écritures concurrentes
_SKILL_LOCKS: dict[str, asyncio.Lock] = {}

# FIX 2 — Executor dédié pour les tests (évite l'épuisement du pool global)
_TEST_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="evolution_test")

ROOT = Path(__file__).resolve().parent.parent

with open(ROOT / "agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(auto_evolve_loop())
    print("🧬 PICO-RUCHE Evolution actif — port 8005 · auto-évolution 1h")
    yield

app = FastAPI(title="PICO-RUCHE Evolution", version="1.0.0", lifespan=lifespan)

SKILLS_DIR = ROOT / "agent" / "skills"
LAYERS_DIR = ROOT / "agent" / "layers"
SKILLS_DIR.mkdir(parents=True, exist_ok=True)
LAYERS_DIR.mkdir(parents=True, exist_ok=True)


def get_repair_backend() -> Optional[str]:
    for tool in ["claude", "aider"]:
        try:
            subprocess.run(["which", tool], check=True, capture_output=True)
            return tool
        except Exception:
            continue
    return None


async def repair_file(file_path: str, error: str) -> dict:
    backend = get_repair_backend()
    if not backend:
        return {"success": False, "error": "Ni claude CLI ni aider disponible"}
    args = (
        ["claude", "-p", f"Fix this error in {file_path}: {error}"]
        if backend == "claude"
        else ["aider", "--message", f"Fix: {error}", file_path]
    )
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120)
        return {
            "success": result.returncode == 0,
            "output": result.stdout[-2000:],
            "backend": backend,
            "file": file_path
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout 120s"}


async def run_tests() -> dict:
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            _TEST_EXECUTOR,
            lambda: subprocess.run(
                ["npm", "test"], capture_output=True, text=True, timeout=120, cwd="."
            )
        )
        output = result.stdout + result.stderr
        # Comptage additionné (pas de court-circuit logique avec 'or')
        passed = output.count("passing") + output.count("✓")
        failed = output.count("failing") + output.count("✗")
        return {
            "success": result.returncode == 0,
            "output": output[-2000:],
            "passed": passed,
            "failed": failed
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout 120s dépassé pour npm test"}
    except FileNotFoundError:
        return {"success": False, "error": "npm non trouvé — tests non disponibles"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def generate_skill(name: str, goal: str, examples: List[dict] = []) -> dict:
    # FIX 3 — Validation du nom pour prévenir le path traversal
    if not re.match(r'^[a-zA-Z0-9_\-]+$', name):
        raise HTTPException(status_code=400, detail=f"Nom de skill invalide: {name}")

    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"http://localhost:{CONFIG['ports']['brain']}/raw",
            json={
                "role": "worker",
                "prompt": f"Crée un skill Python nommé '{name}' qui accomplit: {goal}\nExemples: {json.dumps(examples)}\nRéponds UNIQUEMENT avec du code Python valide, sans markdown.",
                "system": "Tu génères des skills Python pour un agent autonome. Code uniquement, pas d'explication."
            }
        )
    code = r.json().get("content", "")
    code = code.replace("```python", "").replace("```", "").strip()
    skill_file = SKILLS_DIR / f"{name}.py"

    # FIX 1 — Verrou par nom de skill pour sérialiser les écritures concurrentes
    if name not in _SKILL_LOCKS:
        _SKILL_LOCKS[name] = asyncio.Lock()

    # FIX 4 — Purge des locks obsolètes si le dictionnaire dépasse 100 entrées
    if len(_SKILL_LOCKS) > 100:
        to_delete = [k for k in list(_SKILL_LOCKS.keys()) if (SKILLS_DIR / f"{k}.py").exists()]
        for k in to_delete:
            _SKILL_LOCKS.pop(k, None)

    async with _SKILL_LOCKS[name]:
        skill_file.write_text(code)

    try:
        compile(code, str(skill_file), "exec")
        return {"created": True, "file": str(skill_file), "valid_syntax": True}
    except SyntaxError as e:
        return {"created": True, "file": str(skill_file), "valid_syntax": False, "syntax_error": str(e)}


async def analyze_failures() -> dict:
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(
            f"http://localhost:{CONFIG['ports']['memory']}/search",
            json={"keywords": ["failed", "error", "timeout"]}
        )
    failures = r.json().get("results", [])
    if not failures:
        return {"patterns": [], "recommendation": "Aucun échec récent détecté"}
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"http://localhost:{CONFIG['ports']['brain']}/raw",
            json={
                "role": "strategist",
                "prompt": f"Analyse ces {len(failures)} échecs et identifie les patterns. Propose 1 amélioration concrète.\n{json.dumps(failures[-10:])}\nRéponds JSON: {{\"patterns\": [\"string\"], \"recommendation\": \"string\", \"new_skill_needed\": true/false, \"skill_description\": \"string\"}}",
                "system": "Tu analyses des patterns d'échecs pour améliorer un agent autonome."
            }
        )
    try:
        return json.loads(r.json().get("content", "{}"))
    except Exception:
        return r.json()


async def auto_evolve_loop():
    """Boucle d'auto-évolution — analyse les échecs toutes les heures et génère des skills si besoin."""
    print("[Evolution] 🧬 Boucle auto-évolution démarrée (cycle 1h)")
    await asyncio.sleep(60)  # délai initial pour laisser les autres couches démarrer
    while True:
        try:
            analysis = await analyze_failures()
            patterns = analysis.get("patterns", [])
            recommendation = analysis.get("recommendation", "")
            if patterns:
                print(f"[Evolution] 🔍 Patterns détectés: {patterns[:2]}")
                print(f"[Evolution] 💡 Recommandation: {recommendation[:100]}")
            if analysis.get("new_skill_needed") and analysis.get("skill_description"):
                skill_name = f"auto_skill_{int(asyncio.get_event_loop().time())}"
                result = await generate_skill(skill_name, analysis["skill_description"])
                print(f"[Evolution] ✨ Skill généré: {skill_name} — valid: {result.get('valid_syntax')}")
            # Self-repair si un fichier de la ruche a un problème récent
            try:
                async with httpx.AsyncClient(timeout=5) as c:
                    r = await c.post(
                        f"http://localhost:{CONFIG['ports']['memory']}/search",
                        json={"keywords": ["SyntaxError", "ImportError", "ModuleNotFoundError"]}
                    )
                errors = r.json().get("results", [])
                for ep in errors[:1]:
                    err_text = ep.get("result", "")
                    import re as _re
                    match = _re.search(r'File "([^"]+\.py)"', err_text)
                    if match:
                        fpath = match.group(1)
                        print(f"[Evolution] 🔧 Auto-repair: {fpath}")
                        await repair_file(fpath, err_text[:300])
            except Exception:
                pass
        except Exception as e:
            print(f"[Evolution] auto_evolve_loop erreur: {e}")
        await asyncio.sleep(3600)  # cycle 1h


class RepairRequest(BaseModel):
    file_path: str
    error_description: str


class SkillRequest(BaseModel):
    name: str
    goal: str
    examples: List[dict] = []


class SelfRepairLoopRequest(BaseModel):
    max_iterations: int = 3


@app.post("/repair")
async def repair(req: RepairRequest):
    return await repair_file(req.file_path, req.error_description)


@app.post("/self-repair-loop")
async def self_repair_loop(req: SelfRepairLoopRequest):
    results = []
    for i in range(req.max_iterations):
        test_result = await run_tests()
        results.append({"iteration": i + 1, "tests": test_result})
        if test_result["success"]:
            return {"success": True, "iterations": i + 1, "results": results}
        error_match = test_result.get("output", "")
        file_match = None
        match = re.search(r"at .+\((.+\.(?:js|ts|py)):", error_match)
        if match:
            file_match = match.group(1)
            repair_result = await repair_file(file_match, error_match[:500])
            results[-1]["repair"] = repair_result
    return {"success": False, "iterations": req.max_iterations, "results": results}


@app.post("/generate-skill")
async def create_skill(req: SkillRequest):
    return await generate_skill(req.name, req.goal, req.examples)


@app.post("/analyze-failures")
async def analyze():
    return await analyze_failures()


@app.get("/skills")
async def list_skills():
    skills = [f.stem for f in SKILLS_DIR.glob("*.py")]
    return {"skills": skills, "count": len(skills)}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "layer": "evolution",
        "repair_backend": get_repair_backend(),
        "skills_count": len(list(SKILLS_DIR.glob("*.py")))
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=CONFIG["ports"]["evolution"])
