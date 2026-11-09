// ─── Sweep a devnet wallet back to the funder, keeping a reserve ───
// Moves tDVPN (Token-2022 transferChecked, ATA → funder ATA) and then SOL (system transfer),
// leaving --keep-sol SOL and --keep-tdvpn tDVPN. Devnet only; one tx per asset, 7 s apart.
//
//   node scripts/ops/sweep-to-funder.mjs --funder <pubkey> --key <path>|--key-stdin [--keep-sol 0.05] [--keep-tdvpn 1] [--apply]
//
// --key-stdin reads the key JSON from stdin, so a VM's key can be piped over ssh and never lands
// on this box's disk:  ssh <vm> cat <keyfile> | node scripts/ops/sweep-to-funder.mjs --key-stdin --apply
// Without --apply it only prints what it would move. Never prints key bytes.
import { readFileSync } from 'node:fs';
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { rpcCall } from '../../lib/solana/rpc.js';
import { ata } from '../../lib/solana/program.js';
import { MINT } from '../../lib/solana/idl.js';
import { sendIxs } from '../../lib/solana/tx.js';
import { keypairFromJson } from '../../lib/wallet.js';

const DECIMALS = 6;
const FEE_LAMPORTS = 10_000n; // headroom for the two tx fees

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 || !args[i + 1] ? dflt : args[i + 1];
};
const funderArg = opt('--funder', process.env.FUNDER_PUBKEY);
if (!funderArg) throw new Error('pass --funder <pubkey> or set FUNDER_PUBKEY');
const FUNDER = new PublicKey(funderArg);
const APPLY = args.includes('--apply');
if (!/devnet/.test(process.env.SOLANA_NETWORK || 'devnet')) throw new Error('devnet only');

let keyText;
if (args.includes('--key-stdin')) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  keyText = Buffer.concat(chunks).toString('utf8');
} else {
  const p = opt('--key');
  if (!p) throw new Error('pass --key <path> or --key-stdin');
  keyText = readFileSync(p, 'utf8');
}
const kp = keypairFromJson(keyText);
keyText = undefined;
const me = kp.publicKey;
if (me.equals(FUNDER)) throw new Error('refusing to sweep the funder into itself');

const keepSol = BigInt(Math.round(Number(opt('--keep-sol', '0.05')) * LAMPORTS_PER_SOL));
const keepTok = BigInt(Math.round(Number(opt('--keep-tdvpn', '1')) * 10 ** DECIMALS));
const log = (...a) => process.stdout.write(`[sweep] ${a.join(' ')}\n`);
log('wallet', me.toBase58(), '→ funder', FUNDER.toBase58(), APPLY ? '' : '(dry run)');

// ─── tDVPN ───
const myAta = ata(me);
let tok = 0n;
try {
  const b = await rpcCall((c) => c.getTokenAccountBalance(myAta, 'confirmed'), { label: 'sweep:tok' });
  tok = BigInt(b.value.amount);
} catch (err) {
  log('no tDVPN account:', String(err.message).slice(0, 80));
}
const moveTok = tok > keepTok ? tok - keepTok : 0n;
log(`tDVPN ${Number(tok) / 1e6} → move ${Number(moveTok) / 1e6}, keep ${Number(tok - moveTok) / 1e6}`);
if (moveTok > 0n && APPLY) {
  const r = await sendIxs(kp, [createTransferCheckedInstruction(myAta, MINT, ata(FUNDER), me, moveTok, DECIMALS, [], TOKEN_2022_PROGRAM_ID)], 'sweep:tdvpn');
  log('tDVPN sent', r.signature || JSON.stringify(r).slice(0, 120));
  await new Promise((res) => setTimeout(res, 7000));
}

// ─── SOL ───
const lam = BigInt(await rpcCall((c) => c.getBalance(me, 'confirmed'), { label: 'sweep:sol' }));
const moveSol = lam > keepSol + FEE_LAMPORTS ? lam - keepSol - FEE_LAMPORTS : 0n;
log(`SOL ${Number(lam) / 1e9} → move ${Number(moveSol) / 1e9}, keep ≈${Number(lam - moveSol) / 1e9}`);
if (moveSol > 0n && APPLY) {
  const r = await sendIxs(kp, [SystemProgram.transfer({ fromPubkey: me, toPubkey: FUNDER, lamports: moveSol })], 'sweep:sol');
  log('SOL sent', r.signature || JSON.stringify(r).slice(0, 120));
}
