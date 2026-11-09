/**
 * Sentinel Node Tester — Auth Middleware
 * Admin token gate: Bearer header or signed cookie.
 * Public routes use attachAdminFlag for optional context.
 */

import { timingSafeEqual } from 'node:crypto';

// Constant-time string compare. Returns false on any length mismatch
// without leaking length via early-exit timing.
export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// H-02: server injects its session validator so browser cookies carry an
// opaque session ID rather than the raw ADMIN_TOKEN. If the server never
// calls setAdminSessionValidator, browser login is disabled (Bearer header
// continues to work for API callers).
let _adminSessionValidator = () => false;
export function setAdminSessionValidator(fn) {
  if (typeof fn === 'function') _adminSessionValidator = fn;
}

// ─── adminOnly ───────────────────────────────────────────────────────────────
// Blocks the request if no valid ADMIN_TOKEN is presented.
// Accepts:  Authorization: Bearer <token>
//           Cookie: admin_token=<token>  (signed by Express, see server.js cookieParser setup)
export function adminOnly(req, res, next) {
  const token = process.env.ADMIN_TOKEN;

  // No ADMIN_TOKEN configured → local/single-user mode, allow all access.
  // This is intentional: single-user installs (developer workstations) don't need auth.
  // PUBLIC_MODE=true enforces that ADMIN_TOKEN MUST be set before server starts,
  // so this bypass only applies in private/local setups.
  if (!token) {
    req.admin = true;
    return next();
  }

  // Extract from Bearer header (API callers)
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  // Browser path: signed cookie carries an opaque session ID (not ADMIN_TOKEN).
  const sessionId = req.signedCookies?.admin_session || null;

  const bearerOk = bearerToken && safeEq(bearerToken, token);
  const sessionOk = sessionId && _adminSessionValidator(sessionId);

  if (bearerOk || sessionOk) {
    req.admin = true;
    // CSRF double-submit check: non-GET state-changing requests must include
    // the X-Admin-Request: 1 header. Cross-site forms and fetch() without
    // explicit headers cannot set this custom header — browsers block it.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      if (req.headers['x-admin-request'] !== '1') {
        return res.status(403).json({ error: 'Forbidden', hint: 'Include X-Admin-Request: 1 header in all state-changing requests' });
      }
    }
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized', hint: 'Provide a valid Bearer token or log in at /admin/login' });
}

// ─── attachAdminFlag ─────────────────────────────────────────────────────────
// Non-blocking: sets req.admin = true/false so public routes can conditionally
// render admin controls without enforcing authentication.
export function attachAdminFlag(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  // No ADMIN_TOKEN configured → local/single-user mode. There are no anonymous
  // visitors here: the operator IS the admin (PUBLIC_MODE forces ADMIN_TOKEN to
  // be set before any public deployment). Mirror adminOnly's local-mode bypass
  // so req.admin is consistent across both middlewares — otherwise the operator's
  // own browser is flagged non-admin and loses raw_json in the failure drawer.
  if (!token) {
    req.admin = true;
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;
  const sessionId = req.signedCookies?.admin_session || null;

  const bearerOk = bearerToken && safeEq(bearerToken, token);
  const sessionOk = sessionId && _adminSessionValidator(sessionId);

  req.admin = Boolean(bearerOk || sessionOk);
  next();
}
