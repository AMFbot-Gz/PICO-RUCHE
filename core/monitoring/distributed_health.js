// core/monitoring/distributed_health.js — Monitoring distribué des couches
const LAYERS = [
  { name: 'Queen Python',  url: 'http://localhost:8001/health' },
  { name: 'Perception',    url: 'http://localhost:8002/health' },
  { name: 'Brain',         url: 'http://localhost:8003/health' },
  { name: 'Executor',      url: 'http://localhost:8004/health' },
  { name: 'Evolution',     url: 'http://localhost:8005/health' },
  { name: 'Memory',        url: 'http://localhost:8006/health' },
  { name: 'MCP Bridge',    url: 'http://localhost:8007/health' },
];

const BASE_INTERVAL = 15000;   // 15s en nominal
const MAX_INTERVAL  = 120000;  // 2min en backoff
const TIMEOUT_MS    = 3000;

export class DistributedHealthMonitor {
  constructor(eventBus) {
    this.bus     = eventBus;
    this.state   = new Map(); // name → { status, failures, lastCheck, latency }
    this.timers  = new Map();
  }

  start() {
    for (const layer of LAYERS) {
      this.state.set(layer.name, { status: 'unknown', failures: 0, lastCheck: null, latency: 0 });
      this._scheduleCheck(layer, BASE_INTERVAL);
    }
    console.log('[HealthMonitor] 🟢 Démarré — surveillance de', LAYERS.length, 'couches');
  }

  stop() {
    for (const [, tid] of this.timers) clearTimeout(tid);
    this.timers.clear();
    console.log('[HealthMonitor] 🔴 Arrêté');
  }

  _scheduleCheck(layer, delay) {
    const tid = setTimeout(async () => {
      await this._check(layer);
    }, delay);
    tid.unref?.();
    this.timers.set(layer.name, tid);
  }

  async _check(layer) {
    const t0 = Date.now();
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(layer.url, { signal: ctrl.signal });
      clearTimeout(timeout);
      ok = res.ok;
    } catch {}

    const prev  = this.state.get(layer.name);
    const latency = Date.now() - t0;

    if (ok) {
      if (prev.status !== 'ok') {
        console.log(`[HealthMonitor] ✅ ${layer.name} — récupéré (${latency}ms)`);
        this.bus?.emit('layer.recovered', { name: layer.name, latency });
      }
      this.state.set(layer.name, { status: 'ok', failures: 0, lastCheck: Date.now(), latency });
      this._scheduleCheck(layer, BASE_INTERVAL);
    } else {
      const failures = prev.failures + 1;
      console.warn(`[HealthMonitor] ❌ ${layer.name} — DOWN (tentative ${failures})`);
      this.state.set(layer.name, { status: 'down', failures, lastCheck: Date.now(), latency });
      this.bus?.emit('layer.down', { name: layer.name, failures });
      // Backoff exponentiel : 15s → 30s → 60s → 120s
      const next = Math.min(BASE_INTERVAL * Math.pow(2, failures - 1), MAX_INTERVAL);
      this._scheduleCheck(layer, next);
    }
  }

  getStatus() {
    const out = {};
    for (const [name, s] of this.state) out[name] = s;
    return out;
  }

  allHealthy() {
    return [...this.state.values()].every(s => s.status === 'ok');
  }
}

export default DistributedHealthMonitor;
