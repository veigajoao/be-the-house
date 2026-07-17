import { NextResponse } from "next/server";
import { chain } from "../../../lib/server";

export async function GET() {
  const { client } = chain();
  const config = await (client.program.account as any).config.fetch(client.pdas.config());
  const frontends = await (client.program.account as any).frontend.all();
  return NextResponse.json({
    protocolFeeBps: config.protocolFeeBps,
    keeperReward: config.keeperReward.toNumber(),
    frontendFeeBps: frontends[0]?.account.feeBps ?? 0,
    programId: client.program.programId.toBase58(),
    // timing windows (ms) — the UI copy is driven by these so it stays honest
    // whether the deployment uses the tight mainnet spec or widened devnet values
    commitDelayMs: config.commitDelayMs.toNumber(),
    stalenessWindowMs: config.stalenessWindowMs.toNumber(),
    fillToleranceMs: config.fillToleranceMs.toNumber(),
    commitExpiryMs: config.commitExpiryMs.toNumber(),
    voidAfterMs: config.voidAfterMs.toNumber(),
  });
}
