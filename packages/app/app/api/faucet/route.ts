// Test-USDC faucet. Mints to the site's demo wallet by default, or to ANY
// wallet passed as `to` — so real users can fund their own wallets to bet.
// - surfnet: surfnet_setTokenAccount cheatcode
// - devnet:  real mintTo (the demo admin is the test mint's authority)
import { NextRequest, NextResponse } from "next/server";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";

const SOL_TOPUP = 0.05 * LAMPORTS_PER_SOL; // enough for tx fees + bet-account rent
const SOL_FLOOR = 0.02 * LAMPORTS_PER_SOL;

/** Give a connected user wallet some devnet SOL for fees + rent (from the
 * admin key). No-op on surfnet or when the wallet already has enough. */
async function topUpSol(client: ReturnType<typeof chain>["client"], to: PublicKey) {
  if (to.equals(client.signer.publicKey)) return; // demo wallet funds itself
  try {
    const bal = await client.connection.getBalance(to);
    if (bal >= SOL_FLOOR) return;
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: client.signer.publicKey, toPubkey: to, lamports: SOL_TOPUP }),
    );
    tx.recentBlockhash = (await client.connection.getLatestBlockhash()).blockhash;
    tx.feePayer = client.signer.publicKey;
    tx.sign(client.signer);
    const sig = await client.connection.sendRawTransaction(tx.serialize());
    await client.connection.confirmTransaction(sig, "confirmed");
  } catch {
    /* best-effort; USDC still lands */
  }
}

export async function POST(req: NextRequest) {
  const { client } = chain();
  let to = client.signer.publicKey;
  let amountUsdc = 1000;
  try {
    const body = (await req.json()) as { to?: string; amountUsdc?: number };
    if (body.to) to = new PublicKey(body.to);
    if (body.amountUsdc && body.amountUsdc > 0 && body.amountUsdc <= 100_000) {
      amountUsdc = body.amountUsdc;
    }
  } catch {
    /* empty body -> defaults */
  }
  const amount = BigInt(Math.round(amountUsdc * 1_000_000));
  const ata = getAssociatedTokenAddressSync(USDC_MINT, to);

  // try the surfpool cheatcode first
  let current = 0n;
  try {
    current = BigInt((await client.connection.getTokenAccountBalance(ata)).value.amount);
  } catch {
    /* no ATA yet */
  }
  const res = await fetch(client.connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "surfnet_setTokenAccount",
      params: [to.toBase58(), USDC_MINT.toBase58(), { amount: Number(current + amount) }],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message: string } };
  if (!body.error) {
    return NextResponse.json({ ok: true, to: to.toBase58(), added: amountUsdc, via: "surfnet" });
  }

  // not a surfnet — mint for real (works when the signer is the mint authority)
  try {
    const payer = client.signer.publicKey;
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(payer, ata, to, USDC_MINT))
      .add(createMintToInstruction(USDC_MINT, ata, payer, amount));
    const { blockhash } = await client.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;
    tx.sign(client.signer);
    const sig = await client.connection.sendRawTransaction(tx.serialize());
    await client.connection.confirmTransaction(sig, "confirmed");
    await topUpSol(client, to); // devnet SOL for fees + rent so the user can bet
    return NextResponse.json({ ok: true, to: to.toBase58(), added: amountUsdc, via: "mintTo", sig });
  } catch (e) {
    return NextResponse.json(
      { error: `faucet failed: ${(e as Error).message.slice(0, 140)}` },
      { status: 500 },
    );
  }
}
