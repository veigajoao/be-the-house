// Surfnet-only demo faucet: mints USDC to the demo bettor via cheatcode.
import { NextResponse } from "next/server";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";

export async function POST() {
  const { client } = chain();
  const bettor = client.signer.publicKey;
  const ata = getAssociatedTokenAddressSync(USDC_MINT, bettor);
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
      params: [bettor.toBase58(), USDC_MINT.toBase58(), { amount: Number(current + 1_000_000_000n) }],
    }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) return NextResponse.json({ error: body.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, added: 1000 });
}
