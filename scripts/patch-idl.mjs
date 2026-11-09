#!/usr/bin/env node
// ─── patch-idl ───────────────────────────────────────────────────────────────
// Derives chain/idl/dvpn.devnet.json from chain/idl/dvpn.source.json.
//
// Since 2026-11-02 the devnet program (J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs) runs
// upstream cb33092e (public as sentinel-official/sentinel-solana 26de5240, same code), and
// dvpn.source.json IS that IDL (`sentinel-programs/idl/dvpn.json`, byte for byte). Against
// cf4c372 it renames every `rent_payer` field to `rent_recipient` (same type and position,
// so account sizes are unchanged) and adds a `*_rent_recipient` arg to the open_* / close_node
// / close_provider instructions. The only edit made here is the program address.
//
// Fails if the source is not the cb33 IDL, so a stale copy can't slip back in.
//
// Run: node scripts/patch-idl.mjs   (also runs on postinstall)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'chain', 'idl', 'dvpn.source.json');
const OUT = join(here, '..', 'chain', 'idl', 'dvpn.devnet.json');
const DEVNET_PROGRAM_ID = 'J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs';

const idl = JSON.parse(readFileSync(SRC, 'utf8'));
const names = new Set(idl.accounts.map((a) => a.name));
const openSub = idl.instructions.find((i) => i.name === 'open_subscription');
const isCb33 = openSub && openSub.args.some((a) => a.name === 'subscription_rent_recipient');
if (!names.has('Grant') || names.has('OperatorMandate') || !isCb33) {
  throw new Error('patch-idl: dvpn.source.json is not the cb33092e IDL the devnet program runs');
}

idl.address = DEVNET_PROGRAM_ID;
idl.metadata = { ...idl.metadata, derived_from: 'dvpn.source.json (upstream cb33092e)' };

writeFileSync(OUT, JSON.stringify(idl, null, 2) + '\n', 'utf8');
console.log(`patch-idl: wrote ${OUT}`);
