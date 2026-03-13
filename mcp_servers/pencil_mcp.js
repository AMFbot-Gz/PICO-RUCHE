/**
 * pencil_mcp.js — MCP Server pour Pencil.app v1.1.31 (Electron)
 * bundle ID : dev.pencil.desktop
 *
 * Outils exposés :
 *   open_app       — Ouvre/active Pencil.app
 *   new_document   — Crée un nouveau document (via menu ou shortcut)
 *   open_file      — Ouvre un fichier .epgz / .epz dans Pencil
 *   screenshot     — Capture l'état actuel de la fenêtre Pencil
 *   get_windows    — Liste les fenêtres Pencil ouvertes
 *   click_menu     — Déclenche un élément de menu (ex: "File > New")
 *   export_png     — Exporte le document courant en PNG via menu Export
 *   close_app      — Ferme Pencil proprement
 *   focus_window   — Amène la fenêtre Pencil au premier plan
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCREENSHOTS_DIR = join(ROOT, ".laruche/temp/screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const APP_NAME   = "Pencil";
const BUNDLE_ID  = "dev.pencil.desktop";
const APP_PATH   = "/Applications/Pencil.app";
const URL_SCHEME = "pencil";

// ─── Helpers AppleScript ──────────────────────────────────────────────────────

async function runAppleScript(script) {
  const escaped = script.replace(/"/g, '\\"');
  const { stdout, stderr } = await execAsync(`osascript -e "${escaped}"`);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runAppleScriptFile(script) {
  // Écriture dans un fichier tmp pour éviter les problèmes d'échappement
  const { writeFileSync, unlinkSync } = await import("fs");
  const tmp = join(ROOT, ".laruche/temp/pencil_as_tmp.scpt");
  writeFileSync(tmp, script, "utf8");
  const { stdout, stderr } = await execAsync(`osascript "${tmp}"`);
  try { unlinkSync(tmp); } catch { /* ignore */ }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function isPencilRunning() {
  try {
    const { stdout } = await execAsync(`pgrep -x "${APP_NAME}" 2>/dev/null || echo ""`);
    return stdout.trim().length > 0;
  } catch { return false; }
}

async function activatePencil() {
  await runAppleScriptFile(`
    tell application "${APP_NAME}"
      activate
    end tell
  `);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "laruche-pencil",
  version: "1.0.0",
  description: "Contrôle Pencil.app (prototypage/wireframing) via AppleScript et URL scheme",
});

// ── open_app ──────────────────────────────────────────────────────────────────
server.tool(
  "open_app",
  "Ouvre ou active Pencil.app. Si Pencil est déjà ouvert, l'amène au premier plan.",
  {},
  async () => {
    try {
      const running = await isPencilRunning();
      if (running) {
        await activatePencil();
        return { content: [{ type: "text", text: JSON.stringify({ success: true, action: "activated", message: "Pencil est déjà ouvert — fenêtre mise au premier plan." }) }] };
      }
      await execAsync(`open -a "${APP_PATH}"`);
      // Attendre que l'app soit prête (max 8s)
      let ready = false;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await isPencilRunning()) { ready = true; break; }
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: true, action: "launched", ready, message: ready ? "Pencil ouvert avec succès." : "Pencil lancé, démarrage en cours..." }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── new_document ──────────────────────────────────────────────────────────────
server.tool(
  "new_document",
  "Crée un nouveau document Pencil vide (⌘N). Lance Pencil si non ouvert.",
  {},
  async () => {
    try {
      if (!await isPencilRunning()) {
        await execAsync(`open -a "${APP_PATH}"`);
        await new Promise(r => setTimeout(r, 3000));
      }
      await runAppleScriptFile(`
        tell application "${APP_NAME}"
          activate
        end tell
        tell application "System Events"
          tell process "${APP_NAME}"
            keystroke "n" using command down
          end tell
        end tell
      `);
      await new Promise(r => setTimeout(r, 500));
      return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "Nouveau document créé (⌘N envoyé)." }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── open_file ─────────────────────────────────────────────────────────────────
server.tool(
  "open_file",
  "Ouvre un fichier .epgz ou .epz dans Pencil.",
  { path: z.string().describe("Chemin absolu du fichier Pencil (.epgz / .epz)") },
  async ({ path: filePath }) => {
    try {
      if (!existsSync(filePath)) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: `Fichier introuvable : ${filePath}` }) }] };
      }
      await execAsync(`open -a "${APP_PATH}" "${filePath}"`);
      await new Promise(r => setTimeout(r, 1500));
      return { content: [{ type: "text", text: JSON.stringify({ success: true, message: `Fichier ouvert : ${filePath}` }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── screenshot ────────────────────────────────────────────────────────────────
server.tool(
  "screenshot",
  "Capture la fenêtre Pencil active. Retourne le chemin du fichier PNG.",
  {
    filename: z.string().optional().describe("Nom du fichier de sortie (sans extension, défaut: pencil_<timestamp>)"),
  },
  async ({ filename }) => {
    try {
      if (!await isPencilRunning()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Pencil n'est pas ouvert." }) }] };
      }
      await activatePencil();
      await new Promise(r => setTimeout(r, 300));

      const name = filename || `pencil_${Date.now()}`;
      const outPath = join(SCREENSHOTS_DIR, `${name}.png`);

      // Capture fenêtre au premier plan
      await execAsync(`screencapture -l $(osascript -e 'tell application "System Events" to tell process "${APP_NAME}" to get id of window 1' 2>/dev/null || echo "") -x "${outPath}" 2>/dev/null || screencapture -x "${outPath}"`);

      return { content: [{ type: "text", text: JSON.stringify({ success: true, path: outPath, message: `Screenshot sauvegardé : ${outPath}` }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── get_windows ───────────────────────────────────────────────────────────────
server.tool(
  "get_windows",
  "Liste les fenêtres Pencil ouvertes (titres, état).",
  {},
  async () => {
    try {
      if (!await isPencilRunning()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, running: false, windows: [], message: "Pencil n'est pas ouvert." }) }] };
      }
      const result = await runAppleScriptFile(`
        set winList to {}
        tell application "${APP_NAME}"
          repeat with w in windows
            set end of winList to name of w
          end repeat
        end tell
        return winList
      `);
      const windows = result.stdout ? result.stdout.split(", ").filter(Boolean) : [];
      return { content: [{ type: "text", text: JSON.stringify({ success: true, running: true, count: windows.length, windows }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── click_menu ────────────────────────────────────────────────────────────────
server.tool(
  "click_menu",
  "Clique sur un élément de menu dans Pencil (ex: menu='File', item='New'). Supporte les sous-menus.",
  {
    menu:    z.string().describe("Nom du menu principal (ex: 'File', 'Edit', 'View')"),
    item:    z.string().describe("Nom de l'item de menu à cliquer"),
    submenu: z.string().optional().describe("Nom d'un sous-menu intermédiaire si besoin"),
  },
  async ({ menu, item, submenu }) => {
    try {
      if (!await isPencilRunning()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Pencil n'est pas ouvert." }) }] };
      }
      await activatePencil();

      let script;
      if (submenu) {
        script = `
          tell application "System Events"
            tell process "${APP_NAME}"
              click menu item "${submenu}" of menu "${menu}" of menu bar 1
              click menu item "${item}" of menu 1 of menu item "${submenu}" of menu "${menu}" of menu bar 1
            end tell
          end tell
        `;
      } else {
        script = `
          tell application "System Events"
            tell process "${APP_NAME}"
              click menu item "${item}" of menu "${menu}" of menu bar 1
            end tell
          end tell
        `;
      }
      await runAppleScriptFile(script);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, message: `Menu ${menu} > ${submenu ? submenu + ' > ' : ''}${item} cliqué.` }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── export_png ────────────────────────────────────────────────────────────────
server.tool(
  "export_png",
  "Exporte le document Pencil courant en PNG via File > Export. Sauvegarde dans un dossier cible.",
  {
    output_dir: z.string().optional().describe("Dossier de destination (défaut: ~/Desktop)"),
  },
  async ({ output_dir }) => {
    try {
      if (!await isPencilRunning()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Pencil n'est pas ouvert." }) }] };
      }
      await activatePencil();
      await new Promise(r => setTimeout(r, 300));

      // Déclenche File > Export via shortcut ou menu
      await runAppleScriptFile(`
        tell application "System Events"
          tell process "${APP_NAME}"
            -- Essai shortcut export commun
            keystroke "e" using {command down, shift down}
          end tell
        end tell
      `);

      await new Promise(r => setTimeout(r, 800));
      const dir = output_dir || `${process.env.HOME}/Desktop`;
      return { content: [{ type: "text", text: JSON.stringify({ success: true, message: `Export PNG déclenché. Vérifiez la boîte de dialogue dans Pencil. Dossier cible suggéré : ${dir}` }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── close_app ─────────────────────────────────────────────────────────────────
server.tool(
  "close_app",
  "Ferme Pencil proprement (⌘Q). Si force=true, kill -9 le process.",
  { force: z.boolean().optional().describe("Si true, force kill sans dialogue de sauvegarde") },
  async ({ force = false }) => {
    try {
      if (!await isPencilRunning()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "Pencil n'était pas ouvert." }) }] };
      }
      if (force) {
        await execAsync(`pkill -x "${APP_NAME}" 2>/dev/null || true`);
      } else {
        await runAppleScriptFile(`
          tell application "${APP_NAME}"
            quit
          end tell
        `);
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: true, action: force ? "force_killed" : "quit", message: force ? "Pencil tué de force." : "Pencil fermé proprement." }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ── focus_window ──────────────────────────────────────────────────────────────
server.tool(
  "focus_window",
  "Amène Pencil au premier plan et focus la fenêtre.",
  {},
  async () => {
    try {
      if (!await isPencilRunning()) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Pencil n'est pas ouvert." }) }] };
      }
      await runAppleScriptFile(`
        tell application "${APP_NAME}"
          activate
          set frontmost to true
        end tell
      `);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, message: "Pencil mis au premier plan." }) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  }
);

// ─── Démarrage via stdio ──────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
