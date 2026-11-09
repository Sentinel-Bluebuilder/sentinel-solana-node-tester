#!/usr/bin/env node
// ─── patch-pages ─────────────────────────────────────────────────────────────
// Builds the dashboard pages from the Cosmos tester's committed copies plus the edits in
// scripts/dev/page-edits.txt. Every edit must match its expected number of times,
// so a newer Cosmos page either patches cleanly or fails loudly naming the edit.
//
//   node scripts/dev/patch-pages.mjs                 # write the pages into the project
//   node scripts/dev/patch-pages.mjs --out <dir>     # write them elsewhere (the check)
//   COSMOS_TESTER_DIR=<dir> overrides ../sentinel-node-tester
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PAGES = ['admin.html', 'public.html', 'live.html', 'node.html', 'about.html', 'about-modal.js', 'sentinel.css'];

// ─── Edits file parser ───
export function parseEdits(text) {
  const edits = [];
  let cur = null;
  let part = null;
  const flush = () => {
    if (!cur) return;
    for (const k of Object.keys(cur.parts)) cur.parts[k] = cur.parts[k].join('\n');
    edits.push(cur);
  };
  for (const line of text.split('\n')) {
    const head = /^=== (\S+) :: (.+?)(?: :: (\d+))?$/.exec(line);
    if (head) {
      flush();
      cur = { file: head[1], name: head[2], count: head[3] ? Number(head[3]) : 1, parts: {} };
      part = null;
      continue;
    }
    const sec = /^--- (from|from-start|from-end|to)$/.exec(line);
    if (sec && cur) { part = sec[1]; cur.parts[part] = []; continue; }
    if (!cur || !part) {
      if (line.trim() && !line.startsWith('#')) throw new Error(`page-edits: stray line outside a block: ${line.slice(0, 80)}`);
      continue;
    }
    // A "# ─── " section heading ends the block. Other '#' lines inside a part are
    // content (shell comments in the CLI guide); trailing blank lines are trimmed below.
    if (line.startsWith('# ─── ')) { part = null; continue; }
    cur.parts[part].push(line);
  }
  flush();
  for (const e of edits) {
    // Blank lines before the next block are separators, not content.
    for (const k of Object.keys(e.parts)) e.parts[k] = e.parts[k].replace(/\n+$/, '');
    const hasFrom = 'from' in e.parts;
    const hasSpan = 'from-start' in e.parts && 'from-end' in e.parts;
    if (!('to' in e.parts) || hasFrom === hasSpan) throw new Error(`page-edits: "${e.name}" needs "to" and either "from" or "from-start"+"from-end"`);
  }
  return edits;
}

function count(src, needle) { return src.split(needle).length - 1; }

/** Apply one edit; returns the new source or throws with the edit name. */
export function applyEdit(src, e) {
  if ('from' in e.parts) {
    const n = count(src, e.parts.from);
    if (n !== e.count) throw new Error(`${e.file} :: ${e.name}: expected ${e.count} match(es), found ${n}`);
    return src.split(e.parts.from).join(e.parts.to);
  }
  const a = e.parts['from-start'];
  const b = e.parts['from-end'];
  if (count(src, a) !== 1) throw new Error(`${e.file} :: ${e.name}: start text matches ${count(src, a)} times`);
  if (count(src, b) !== 1) throw new Error(`${e.file} :: ${e.name}: end text matches ${count(src, b)} times`);
  const i = src.indexOf(a);
  const j = src.indexOf(b);
  if (j < i) throw new Error(`${e.file} :: ${e.name}: end text comes before the start text`);
  return src.slice(0, i) + e.parts.to + src.slice(j + b.length);
}

// ─── Cosmos source ───
// Read the Cosmos tester's COMMITTED file (git HEAD), never its working copy: the
// Cosmos checkout can hold someone's unreleased edits, and test.sentinel.co runs
// what is committed. COSMOS_REF overrides the ref; a dir that is not a git repo
// (e.g. an unpacked release) is read as-is.
export function readCosmos(cosmosDir, file) {
  const ref = process.env.COSMOS_REF || 'HEAD';
  if (!existsSync(join(cosmosDir, '.git'))) return readFileSync(join(cosmosDir, file), 'utf8');
  return execFileSync('git', ['-C', cosmosDir, '-c', 'core.autocrlf=false', 'show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Build every page from the Cosmos copies. Returns { file: content }. */
export function buildPages(cosmosDir, editsText) {
  const edits = parseEdits(editsText);
  const out = {};
  for (const f of PAGES) out[f] = readCosmos(cosmosDir, f);
  for (const e of edits) {
    if (!(e.file in out)) throw new Error(`page-edits: unknown file "${e.file}" in "${e.name}"`);
    out[e.file] = applyEdit(out[e.file], e);
  }
  return { pages: out, edits };
}

// ─── CLI ───
const isMain = process.argv[1] && join(process.argv[1]) === join(fileURLToPath(import.meta.url));
if (isMain) {
  const i = process.argv.indexOf('--out');
  const outDir = i > 0 ? process.argv[i + 1] : ROOT;
  const cosmos = process.env.COSMOS_TESTER_DIR || join(ROOT, '..', 'sentinel-node-tester');
  try {
    const { pages, edits } = buildPages(cosmos, readFileSync(join(ROOT, 'scripts', 'dev', 'page-edits.txt'), 'utf8'));
    mkdirSync(outDir, { recursive: true });
    for (const [f, src] of Object.entries(pages)) writeFileSync(join(outDir, f), src);
    console.log(`✓ ${edits.length} edits applied → ${Object.keys(pages).length} pages in ${outDir}`);
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
