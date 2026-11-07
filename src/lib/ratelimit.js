// Tiny fixed-window in-memory rate limiter (single process, so no shared store needed).
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.max(windowMs, 60000));
    this.timer.unref();
  }

  // Returns { allowed, remaining, retryAfterMs }.
  hit(key, cost = 1) {
    const t = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= t) {
      e = { count: 0, reset: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += cost;
    return { allowed: e.count <= this.max, remaining: Math.max(0, this.max - e.count), retryAfterMs: e.reset - t };
  }

  peek(key) {
    const e = this.hits.get(key);
    if (!e || e.reset <= Date.now()) return { blocked: false, retryAfterMs: 0 };
    return { blocked: e.count >= this.max, retryAfterMs: e.reset - Date.now() };
  }

  reset(key) {
    this.hits.delete(key);
  }

  sweep() {
    const t = Date.now();
    for (const [k, e] of this.hits) if (e.reset <= t) this.hits.delete(k);
  }

  stop() {
    clearInterval(this.timer);
  }
}
