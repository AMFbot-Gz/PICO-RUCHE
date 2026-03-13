/**
 * ecosystem.config.js — PM2 Process Manager Config
 *
 * Modes:
 *   laruche start --headless → queen + watcher only
 *   laruche start            → + dashboard
 *   laruche start --full     → + HUD Electron
 *
 * LARUCHE_MODE=low|balanced|high → performance profile
 */

const MODE = process.env.LARUCHE_MODE || "balanced";

const memoryLimits = {
  low:      { queen: "200M", hud: "100M", dashboard: "100M", watcher: "30M" },
  balanced: { queen: "500M", hud: "150M", dashboard: "200M", watcher: "50M" },
  high:     { queen: "1G",   hud: "250M", dashboard: "400M", watcher: "50M" },
};

const mem = memoryLimits[MODE] || memoryLimits.balanced;

export default {
  apps: [
    // ── Core (always started) ───────────────────────────────────────────────
    {
      name: "laruche-queen",
      script: "src/queen_oss.js",            // ← canonical entry point
      watch: false,
      restart_delay: 3000,
      max_memory_restart: mem.queen,
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
        API_PORT: 3000,
        HUD_PORT: 9001,
        STANDALONE_MODE: "false",
        HITL_AUTO_APPROVE: "true",
        LARUCHE_MODE: MODE,
        QUEEN_MAX_PARALLEL: 3,
        LLM_TIMEOUT_MS: 90000,
        SELFDEV_TIMEOUT_MS: 30000,
      },
      env_development: {
        NODE_ENV: "development",
        PORT: 3000,
        API_PORT: 3000,
        HUD_PORT: 9001,
        STANDALONE_MODE: "false",
        HITL_AUTO_APPROVE: "true",
        LARUCHE_MODE: "balanced",
        LOG_LEVEL: "debug",
        QUEEN_MAX_PARALLEL: 3,
        LLM_TIMEOUT_MS: 90000,
        SELFDEV_TIMEOUT_MS: 30000,
      },
      log_file: ".laruche/logs/queen.log",
      error_file: ".laruche/logs/queen-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      name: "laruche-watcher",
      script: "src/watcher.js",
      max_memory_restart: mem.watcher,
      log_file: ".laruche/logs/watcher.log",
      error_file: ".laruche/logs/watcher-error.log",
      merge_logs: true,
    },
    // ── Dashboard (started unless --headless) ───────────────────────────────
    {
      name: "laruche-dashboard",
      script: "dashboard/server.js",
      max_memory_restart: mem.dashboard,
      env_production: { NODE_ENV: "production", LARUCHE_MODE: MODE },
      log_file: ".laruche/logs/dashboard.log",
      error_file: ".laruche/logs/dashboard-error.log",
      merge_logs: true,
    },
    // ── HUD Electron (started only with --full) ─────────────────────────────
    {
      name: "laruche-hud",
      script: "hud/main.js",
      interpreter: "electron",
      max_memory_restart: mem.hud,
      log_file: ".laruche/logs/hud.log",
      error_file: ".laruche/logs/hud-error.log",
      merge_logs: true,
    },
    // ── PICO extensions ──────────────────────────────────────────────────────
    { name: 'pico-compressor', script: 'mcp_servers/mcp-compressor/index.js', watch: false, autorestart: true },
    { name: 'pico-context-manager', script: 'mcp_servers/mcp-context-manager/index.js', watch: false, autorestart: true },
    // ── Python agents ────────────────────────────────────────────────────────
    { name: 'pico-queen-py', script: 'agent/queen.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
    { name: 'pico-mcp-bridge', script: 'agent/mcp_bridge.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
    { name: 'pico-brain', script: 'agent/brain.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
    { name: 'pico-perception', script: 'agent/perception.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
    { name: 'pico-memory', script: 'agent/memory.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
    { name: 'pico-executor', script: 'agent/executor.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
    { name: 'pico-evolution', script: 'agent/evolution.py', interpreter: 'python3', watch: false, autorestart: true, cwd: './' },
  ],
};
