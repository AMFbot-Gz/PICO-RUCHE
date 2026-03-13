/**
 * intentPipeline.js — Pipeline intention -> plan -> exécution avec vision loop v3
 *
 * v3: loadDynamicSkills() remplacé par loadSkillHandlers() via getAllSkills() (skillLoader.js)
 */

import { plan, isComputerUseIntent } from "./planner.js";
import { getAllSkills } from "../skills/skillLoader.js";
import { ask } from "../model_router.js";
import { execa } from "execa";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { executeSequence } from './executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

// --- MCP caller with Retry ---------------------------------------------------

async function callMCP(serverFile, toolName, args = {}, timeout = 20000) {
  const rpcRequest = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { stdout, stderr } = await execa("node", [join(ROOT, "mcp_servers", serverFile)], {
        input: rpcRequest,
        cwd: ROOT,
        timeout,  // Timeout fixe — pas exponentiel (évite 8s+16s+24s=48s total)
        reject: false,
      });

      if (!stdout?.trim()) {
        if (stderr) throw new Error(stderr);
        throw new Error("Empty MCP response");
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (parseErr) {
        throw new Error(`MCP JSON invalide: ${parseErr.message}`);
      }
      if (parsed.error) throw new Error(parsed.error.message || "MCP Error");

      const text = parsed.result?.content?.[0]?.text;
      if (text) {
        try {
          return JSON.parse(text);
        } catch {
          return { success: true, raw: text };
        }
      }
      return parsed.result || { success: true };
    } catch (e) {
      lastError = e.message;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return { success: false, error: `Failed after 3 attempts: ${lastError}` };
}

// --- Vision loop -------------------------------------------------------------

async function visionValidate(question) {
  try {
    const { stdout } = await execa("python3", [
      join(ROOT, "src/vision.py"),
      "--fn", "analyze_screen",
      "--args", JSON.stringify({ question }),
    ], { cwd: ROOT, timeout: 15000, reject: false });
    const result = JSON.parse(stdout);
    return result?.response || "";
  } catch {
    return "";
  }
}

async function takeScreenshot() {
  const pwResult = await callMCP("playwright_mcp.js", "pw.screenshot", {}, 8000);
  if (pwResult?.success && pwResult?.path) return pwResult.path;
  const osResult = await callMCP("os_control_mcp.js", "screenshot", {}, 8000);
  return osResult?.path || null;
}

// --- Chargement des skill handlers via skillLoader ---------------------------

let _skillHandlers = null;
let _skillHandlersTs = 0;

async function loadSkillHandlers() {
  if (_skillHandlers && Date.now() - _skillHandlersTs < 30000) return _skillHandlers;

  const allSkills = getAllSkills();
  const handlers = {};

  for (const skill of allSkills) {
    if (!skill.indexPath) continue;
    try {
      const mod = await import(skill.indexPath);
      if (typeof mod.run === "function") {
        handlers[skill.name] = (params) => mod.run(params);
      }
    } catch { /* skip broken skills */ }
  }

  _skillHandlers = handlers;
  _skillHandlersTs = Date.now();
  return handlers;
}

// --- Handlers builtin --------------------------------------------------------

const BUILTIN_HANDLERS = {
  open_safari:       (p) => callMCP("browser_mcp.js", "os.openApp", { app: "Safari" }),
  go_to_youtube:     (p) => callMCP("playwright_mcp.js", "pw.goto", { url: "https://www.youtube.com" }),
  search_youtube:    (p) => callMCP("playwright_mcp.js", "pw.searchYouTube", { query: p.query || "relaxing music" }),
  play_first_result: (p) => callMCP("playwright_mcp.js", "pw.clickFirstYoutubeResult", {}),
  open_app:          (p) => callMCP("browser_mcp.js", "os.openApp", { app: p.app || "Safari" }),
  focus_app:         (p) => callMCP("browser_mcp.js", "os.focusApp", { app: p.app || "Safari" }),
  goto_url:          (p) => callMCP("playwright_mcp.js", "pw.goto", { url: p.url }),
  click_element:     (p) => callMCP("playwright_mcp.js", "pw.click", { selector: p.selector }),
  fill_field:        (p) => callMCP("playwright_mcp.js", "pw.fill", { selector: p.selector, text: p.text }),
  press_key:         (p) => callMCP("playwright_mcp.js", "pw.press", { key: p.key || "Enter" }),
  take_screenshot:   (p) => callMCP("playwright_mcp.js", "pw.screenshot", {}),
  extract_text:      (p) => callMCP("playwright_mcp.js", "pw.extract", { selector: p.selector }),
  run_command:       (p) => callMCP("terminal_mcp.js", "execSafe", { command: p.command }),
  type_text:         (p) => callMCP("os_control_mcp.js", "typeText", { text: p.text || p.query || "" }),
  press_enter:       (p) => callMCP("browser_mcp.js", "browser.pressEnter", {}),
};

// --- Exécution d'un step ----------------------------------------------------

async function executeStep(step, hudFn, useVision = false) {
  const { skill, params = {} } = step;
  hudFn?.({ type: "task_start", task: `${skill}(${JSON.stringify(params).slice(0, 50)})` });

  const dynamicHandlers = await loadSkillHandlers();
  const handler = dynamicHandlers[skill] || BUILTIN_HANDLERS[skill];

  if (!handler) {
    const e = { success: false, error: `Skill non trouvé: ${skill}` };
    hudFn?.({ type: "task_done", task: skill, status: "error" });
    return e;
  }

  let result;
  try {
    result = await handler(params);
  } catch (e) {
    result = { success: false, error: e.message };
  }

  if (useVision && result?.success !== false) {
    await new Promise(r => setTimeout(r, 800));
    const visionCheck = await visionValidate(
      `Le skill "${skill}" vient d'être exécuté. Qu'est-ce qui s'affiche à l'écran? Y a-t-il une erreur visible?`
    );
    if (visionCheck) {
      result._vision = visionCheck.slice(0, 200);
      const errorSignals = ["erreur", "error", "failed", "impossible", "introuvable", "not found", "popup", "alerte"];
      if (errorSignals.some(s => visionCheck.toLowerCase().includes(s))) {
        result._vision_warning = true;
        hudFn?.({ type: "thinking", agent: "Vision", thought: `⚠️ ${visionCheck.slice(0, 100)}` });
      }
    }
  }

  const ok = result?.success !== false;
  hudFn?.({ type: "task_done", task: skill, status: ok ? "ok" : "error" });
  return result;
}

// --- Auto-correction ---------------------------------------------------------

async function tryAutoCorrect(failedStep, errorMsg, hudFn) {
  hudFn?.({ type: "thinking", agent: "Self-Correct", thought: `Tentative correction: ${failedStep.skill}` });
  const screenshotPath = await takeScreenshot();
  let visionContext = "";
  if (screenshotPath) {
    visionContext = await visionValidate(
      `Le skill "${failedStep.skill}" a échoué avec l'erreur: "${errorMsg}". Que vois-tu à l'écran? Que faut-il faire pour corriger?`
    );
  }
  if (!visionContext) return null;

  const prompt = `Un step a échoué. Skill: ${failedStep.skill} Params: ${JSON.stringify(failedStep.params)} Erreur: ${errorMsg} Écran: ${visionContext.slice(0, 300)} Propose un step JSON corrigé: {"skill": "nom_skill", "params": {...}}`;
  try {
    const result = await ask(prompt, { role: 'worker', temperature: 0.1, timeout: 15000 });
    if (result.success && result.text) {
      const match = result.text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    }
  } catch { /* fallback */ }
  return null;
}

// --- Pipeline principal ------------------------------------------------------

export async function runIntentPipeline(intent, {
  hudFn, onPlanReady, onStepDone,
  useVision = process.env.LARUCHE_MODE !== "low",
  usePlaywright = true,
} = {}) {
  const startTime = Date.now();
  hudFn?.({ type: "thinking", agent: "Planner", thought: `"${intent.slice(0, 60)}"` });

  const planResult = await plan(intent);

  // Fallback textuel : si aucun step valide → réponse LLM directe via run_command echo
  if (planResult.error || planResult.steps.length === 0) {
    hudFn?.({ type: "thinking", agent: "Planner", thought: "Plan vide → réponse LLM directe" });
    const { ask } = await import("../model_router.js");
    const fallback = await ask(intent, { role: 'worker', temperature: 0.4, timeout: 30000 });
    const text = fallback.text || planResult.error || "Aucune réponse";
    const duration = Date.now() - startTime;
    hudFn?.({ type: "mission_complete", duration });
    return {
      success: true,
      goal: intent,
      steps: [{ step: { skill: 'llm_answer', params: {} }, result: { success: true, message: text }, success: true }],
      model: fallback.model || 'llm',
      duration,
      _textResponse: text,
    };
  }

  onPlanReady?.(planResult);
  hudFn?.({ type: "plan_ready", tasks: planResult.steps.length, goal: planResult.goal });

  if (usePlaywright) {
    await callMCP("playwright_mcp.js", "pw.launch", { browser: "chromium" }, 15000).catch(() => {});
  }

  const execution = await executeSequence(planResult.steps, {
    hudFn,
    stopOnError: false,
  });

  const results = execution.results;
  const allOk = execution.success;

  const duration = Date.now() - startTime;
  hudFn?.({ type: "mission_complete", duration });

  return { success: allOk, goal: planResult.goal, confidence: planResult.confidence, steps: results, model: planResult.model, duration };
}

export { isComputerUseIntent };
