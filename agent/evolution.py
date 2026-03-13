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
from datetime import datetime
from pathlib import Path
from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List
import yaml

with open("agent_config.yml") as f:
    CONFIG = yaml.safe_load(f)

app = FastAPI(title="PICO-RUCHE Evolution", version="1.0.0")

SKILLS_DIR = Path("agent/skills")
LAYERS_DIR = Path("agent/layers")
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
        result = subprocess.run(
            ["npm", "test"], capture_output=True, text=True, timeout=120, cwd="."
        )
        output = result.stdout + result.stderr
        passed = output.count("passing") or output.count("✓")
        failed = output.count("failing") or output.count("✗")
        return {
            "success": result.returncode == 0,
            "output": output[-2000:],
            "passed": passed,
            "failed": failed
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def generate_skill(name: str, goal: str, examples: List[dict] = []) -> dict:
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
