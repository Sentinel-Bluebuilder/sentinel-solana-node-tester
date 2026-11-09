/**
 * Sentinel Node Tester (Solana) — on-chain report adapter.
 * The SNTR1 v3 wire format, packer and broadcaster live in lib/onchain-report.js
 * (SPL Memo signed by the tester wallet). This adapter keeps the Cosmos
 * signatures the shared code calls:
 *   commitBatch(client, signerAddress, memo) → { txhash, height, memoBytes }
 *   queryReports(address, { limit })        → [{ txhash, height, payload }]
 */

import { getKeypair } from '../lib/wallet.js';
import {
  resultToRecord, packBatch, decodeMemo, commitBatch as commitMemo, queryReports as queryMemos, SCHEMA,
} from '../lib/onchain-report.js';

export { resultToRecord, packBatch, decodeMemo, SCHEMA };

export async function commitBatch(_client, _signerAddress, memo) {
  const r = await commitMemo(getKeypair(), memo);
  return { txhash: r.signature, height: r.slot, memoBytes: r.memoChars, base64Bytes: r.memoChars };
}

export async function queryReports(address, { limit = 20 } = {}) {
  const rows = await queryMemos(address, { limit });
  return rows.map((r) => ({ txhash: r.signature, height: r.slot, blockTime: r.blockTime, payload: r.payload }));
}
