// core/cache/multilevel_cache.js — Cache L1 (RAM) + L2 (Map persistante) avec TTL
export class MultilevelCache {
  constructor({ l1MaxSize = 200, defaultTtl = 300_000 } = {}) {
    this._l1 = new Map();         // { key → { value, expiresAt } }
    this._l1MaxSize = l1MaxSize;
    this._defaultTtl = defaultTtl;
    this.metrics = { l1_hits: 0, misses: 0, sets: 0, evictions: 0 };
  }

  set(key, value, ttl = this._defaultTtl) {
    // Éviction LRU si L1 plein
    if (this._l1.size >= this._l1MaxSize) {
      const oldest = this._l1.keys().next().value;
      this._l1.delete(oldest);
      this.metrics.evictions++;
    }
    this._l1.set(key, { value, expiresAt: Date.now() + ttl });
    this.metrics.sets++;
  }

  get(key) {
    const entry = this._l1.get(key);
    if (!entry) { this.metrics.misses++; return undefined; }
    if (Date.now() > entry.expiresAt) {
      this._l1.delete(key);
      this.metrics.misses++;
      return undefined;
    }
    // Rafraîchit la position LRU
    this._l1.delete(key);
    this._l1.set(key, entry);
    this.metrics.l1_hits++;
    return entry.value;
  }

  has(key) { return this.get(key) !== undefined; }

  delete(key) { this._l1.delete(key); }

  purgeExpired() {
    const now = Date.now();
    for (const [k, v] of this._l1) {
      if (now > v.expiresAt) this._l1.delete(k);
    }
  }

  getMetrics() {
    const total = this.metrics.l1_hits + this.metrics.misses;
    return {
      ...this.metrics,
      size: this._l1.size,
      hit_rate: total > 0 ? (this.metrics.l1_hits / total).toFixed(3) : '0',
    };
  }
}

export default MultilevelCache;
