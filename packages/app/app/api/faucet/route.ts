// Demo faucet: mints USDC to the demo bettor.
// - surfnet: surfnet_setTokenAccount cheatcode
// - devnet: real mintTo (the demo admin is the test mint's authority)
import { NextResponse } from "next/server";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";

const AMOUNT = 1_000_000_000n; // 1000 USDC

export async function POST() {
  const { client } = chain();
  const bettor = client.signer.publicKey;
  const ata = getAssociatedTokenAddressSync(USDC_MINT, bettor);

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
      params: [bettor.toBase58(), USDC_MINT.toBase58(), { amount: Number(current + AMOUNT) }],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message: string } };
  if (!body.error) return NextResponse.json({ ok: true, added: 1000, via: "surfnet" });

  // not a surfnet — mint for real (works when the signer is the mint authority)
  try {
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(bettor, ata, bettor, USDC_MINT))
      .add(createMintToInstruction(USDC_MINT, ata, bettor, AMOUNT));
    const { blockhash } = await client.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = bettor;
    tx.sign(client.signer);
    const sig = await client.connection.sendRawTransaction(tx.serialize());
    await client.connection.confirmTransaction(sig, "confirmed");
    return NextResponse.json({ ok: true, added: 1000, via: "mintTo", sig });
  } catch (e) {
    return NextResponse.json(
      { error: `faucet failed (not a surfnet, and mintTo failed: ${(e as Error).message.slice(0, 120)})` },
      { status: 500 },
    );
  }
}
