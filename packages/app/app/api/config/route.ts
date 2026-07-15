import { NextResponse } from "next/server";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";

export async function GET() {
  const { client } = chain();
  const config = await (client.program.account as any).config.fetch(client.pdas.config());
  const frontends = await (client.program.account as any).frontend.all();
  const bettor = client.signer.publicKey;
  let usdc = 0;
  try {
    const bal = await client.connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(USDC_MINT, bettor),
    );
    usdc = Number(bal.value.amount);
  } catch {
    /* no ATA yet */
  }
  return NextResponse.json({
    protocolFeeBps: config.protocolFeeBps,
    keeperReward: config.keeperReward.toNumber(),
    frontendFeeBps: frontends[0]?.account.feeBps ?? 0,
    bettor: bettor.toBase58(),
    bettorUsdc: usdc,
    programId: client.program.programId.toBase58(),
  });
}
