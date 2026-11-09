#!/usr/bin/env node
// ─── Bandwidth lab: close this copy's tracked test channels ───
// A lab client VM runs sessions without the server, so nothing sweeps its channels. Run this
// there after the 2 h grace (and once more to settle): the same sweep the server runs, over
// this copy's own `sol_channels` and its own TEST_KEYFILE wallet. `--dry-run` only reports.
import 'dotenv/config';
import { getKeypair } from '../../lib/wallet.js';
import { sweepTestChannels } from '../../audit/channels.js';

const out = await sweepTestChannels(getKeypair(), { dryRun: process.argv.includes('--dry-run'), log: (m) => console.log(`  ${m}`) });
console.log(JSON.stringify({
  startedClose: out.startedClose.length, closed: out.closed.length, pending: out.pending.length, gone: out.gone.length,
  withdrawnBase: out.withdrawnBase, nextMaturity: out.pending.map((p) => p.maturesAt).sort().pop() || null, errors: out.errors,
}));
process.exit(out.errors.length ? 1 : 0);
