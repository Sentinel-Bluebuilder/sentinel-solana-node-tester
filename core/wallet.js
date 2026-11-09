/**
 * Sentinel Node Tester (Solana) — wallet adapter.
 * Cosmos exported cachedWalletSetup / createFreshClient / signAndBroadcastRetry
 * around a CosmJS client. Here the wallet is the TEST_KEYFILE keypair; the
 * "client" exposes the one method the shared pipeline/server use —
 * getBalance(address) → { amount } in tDVPN base units (6 decimals, the same
 * scale the dashboards already divide by for udvpn).
 */

import { getKeypair, walletBalances } from '../lib/wallet.js';

export async function tokenBalanceBase() {
  const w = await walletBalances();
  return { amount: w.tokenBase, lamports: w.lamports, sol: w.sol, userBalanceBase: w.userBalanceBase, openChannels: w.openChannels, address: w.address };
}

export function createSolanaClient() {
  return {
    async getBalance() {
      const b = await tokenBalanceBase();
      return { denom: 'tdvpn', amount: b.amount, lamports: b.lamports };
    },
    disconnect() {},
  };
}

/** Cosmos signature kept: (mnemonic) → { wallet, account, privkey }. */
export async function cachedWalletSetup() {
  const keypair = getKeypair();
  return { wallet: keypair, account: { address: keypair.publicKey.toBase58() }, privkey: null, keypair };
}

export async function createFreshClient() {
  return createSolanaClient();
}

export async function signAndBroadcastRetry() {
  throw new Error('signAndBroadcastRetry is Cosmos-only; Solana writes go through lib/solana/tx.js');
}
