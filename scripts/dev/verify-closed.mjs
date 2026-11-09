// Every channel an instance tracks as closed must be gone on chain; refunds summed.
import { Connection, PublicKey } from '@solana/web3.js';
const [url, token] = process.argv.slice(2);
const h = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const j = await (await fetch(`${url}/api/solana/channels`, { headers: h })).json();
const t = j.tracked;
const closed = t.filter((c) => c.status === 'closed');
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
let gone = 0, still = [];
for (let i = 0; i < closed.length; i += 100) {
  const infos = await conn.getMultipleAccountsInfo(closed.slice(i, i + 100).map((c) => new PublicKey(c.address)));
  infos.forEach((info, k) => (info ? still.push(closed[i + k].address) : gone++));
}
const refunded = closed.reduce((s, c) => s + Number(c.refunded_base || 0), 0);
const byStatus = t.reduce((m, c) => ((m[c.status] = (m[c.status] || 0) + 1), m), {});
console.log(JSON.stringify({ tracked: t.length, byStatus, closedGoneOnChain: gone, closedStillOnChain: still, refundedBase: refunded }));
