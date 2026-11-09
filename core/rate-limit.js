/**
 * core/rate-limit.js — In-memory token-bucket rate limiter middleware factory.
 * No external dependencies. LRU-style eviction caps state at 5 000 IPs.
 */

// ─── Constants ───────────────────────────────────────────────────────────────
const MAX_IPS = 5_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract client IP from request.
 * Uses req.ip only — X-Forwarded-For is NOT trusted here.
 * If the server runs behind a trusted reverse proxy, set
 * `app.set('trust proxy', 1)` in server.js and Express will
 * normalise req.ip from X-Forwarded-For automatically.
 */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * LRU-style eviction: delete the entry that was inserted earliest.
 * Map iteration order is insertion order in V8, so the first key is oldest.
 */
function evictOldest(map) {
  const first = map.keys().next().value;
  if (first !== undefined) map.delete(first);
}

// ─── Token-bucket rate limiter ───────────────────────────────────────────────

/**
 * rateLimit({ windowMs, max, bucket })
 *
 * Returns an Express middleware that enforces a sliding-window counter:
 *   • windowMs  — rolling window length in milliseconds (default 60 000)
 *   • max       — maximum requests allowed per IP in that window (default 120)
 *   • bucket    — label used only for logging / error messages
 *
 * State: one Map<ip, { count, windowStart }> per middleware instance.
 * LRU-style eviction keeps the map at most MAX_IPS entries.
 * On 429: sends JSON { error: 'rate_limited', retryAfter: seconds } and
 *         sets Retry-After header.
 */
function rateLimit({ windowMs = 60_000, max = 120, bucket = 'default' } = {}) {
  /** @type {Map<string, { count: number, windowStart: number }>} */
  const store = new Map();

  // Periodic full sweep: every windowMs, clear entries whose window has expired.
  // This prevents unbounded growth even without LRU pressure.
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, rec] of store) {
      if (rec.windowStart < cutoff) store.delete(ip);
    }
  }, windowMs).unref();

  // Allow the process to exit even if the interval is still running.
  if (sweepInterval.unref) sweepInterval.unref();

  return function rateLimitMiddleware(req, res, next) {
    const ip = clientIp(req);
    const now = Date.now();

    let rec = store.get(ip);

    // Start a new window if first visit or previous window expired.
    if (!rec || now - rec.windowStart >= windowMs) {
      // Evict oldest entry before inserting a new IP to cap map size.
      if (!rec && store.size >= MAX_IPS) evictOldest(store);
      rec = { count: 0, windowStart: now };
      store.set(ip, rec);
    }

    rec.count += 1;

    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.windowStart + windowMs - now) / 1_000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfter, bucket });
    }

    next();
  };
}

// ─── SSE concurrent-connection limiter ───────────────────────────────────────

/**
 * sseLimit({ maxPerIp, bucket })
 *
 * Returns an Express middleware for SSE endpoints that enforces a per-IP
 * concurrent-connection ceiling.
 *   • maxPerIp — max simultaneous open connections from a single IP (default 5)
 *   • bucket   — label for error messages
 *
 * State: one Map<ip, count> shared across all requests handled by this instance.
 * The middleware:
 *   1. Rejects immediately with 429 if count >= maxPerIp.
 *   2. Otherwise increments the counter, attaches a 'close' listener that
 *      decrements it when the client disconnects.
 */
function sseLimit({ maxPerIp = 5, bucket = 'sse' } = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map();

  return function sseLimitMiddleware(req, res, next) {
    const ip = clientIp(req);
    const current = counts.get(ip) || 0;

    if (current >= maxPerIp) {
      res.setHeader('Retry-After', '10');
      return res.status(429).json({
        error: 'rate_limited',
        retryAfter: 10,
        bucket,
        detail: `Max ${maxPerIp} concurrent SSE connections per IP`,
      });
    }

    counts.set(ip, current + 1);

    req.on('close', () => {
      const n = (counts.get(ip) || 1) - 1;
      if (n <= 0) {
        counts.delete(ip);
      } else {
        counts.set(ip, n);
      }
    });

    next();
  };
}

export { rateLimit, sseLimit };
