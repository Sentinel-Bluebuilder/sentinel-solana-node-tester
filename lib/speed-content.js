// ─── Speed-test content: per-test bytes a node cannot predict, cache or compress ───
// The origin streams AES-256-CTR keystream bytes keyed by HMAC(secret, seed). The seed is
// fresh per test and the secret is shared only by the tester and its origin, so a node on
// the path cannot serve the bytes from a cache, from zeros or compressed. The tester
// recomputes the SHA-256 of exactly the prefix that arrived and compares it with the hash
// the client container computed over what it received.
import { createCipheriv, createHmac, createHash, randomBytes } from 'node:crypto';

const CHUNK = 64 * 1024;
const ZERO = Buffer.alloc(CHUNK);

/** 32-byte AES key for one test. */
export function contentKey(secret, seed) {
  // Trimmed: a secret file written on Windows ends in \r\n, and `$(cat …)` keeps the \r on Linux.
  const s = String(secret ?? '').trim();
  if (!s || !seed) throw new Error('contentKey needs a secret and a seed');
  return createHmac('sha256', s).update(String(seed)).digest();
}

/** A fresh, URL-safe seed for one test. */
export function newSeed() {
  return randomBytes(12).toString('hex');
}

/**
 * Generator of `bytes` content bytes in CHUNK pieces (the last one shorter).
 * Infinity streams until the consumer stops pulling.
 */
export function* contentChunks(secret, seed, bytes = Infinity) {
  const cipher = createCipheriv('aes-256-ctr', contentKey(secret, seed), Buffer.alloc(16));
  let left = bytes;
  while (left > 0) {
    const n = Math.min(CHUNK, left);
    yield cipher.update(n === CHUNK ? ZERO : ZERO.subarray(0, n));
    left -= n;
  }
}

/** SHA-256 (hex) of the first `bytes` content bytes — what an honest delivery hashes to. */
export function expectedSha256(secret, seed, bytes) {
  const h = createHash('sha256');
  for (const c of contentChunks(secret, seed, bytes)) h.update(c);
  return h.digest('hex');
}
