// Commit a bet signed by the local demo keypair. Auto-retries the next-best
// house when a house can't collateralize (synchronous failure by design).
import { NextRequest, NextResponse } from "next/server";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";
import { getFixtures, getQuotes } from "../../../lib/market";

export async function POST(req: NextRequest) {
  const { fixtureId, outcome, stakeUsdc } = (await req.json()) as {
    fixtureId: number;
    outcome: number;
    stakeUsdc: number;
  };
  const { client } = chain();

  // fixture kickoff + best-house routing from the API
  const [fixtures, quotes] = await Promise.all([
    getFixtures(),
    getQuotes(fixtureId),
  ]);
  const fixture = fixtures.find((f) => f.FixtureId === fixtureId);
  if (!fixture) return NextResponse.json({ error: "unknown fixture" }, { status: 404 });
  if (!quotes) return NextResponse.json({ error: "no live quotes" }, { status: 409 });

  const bettor = client.signer.publicKey;
  const bettorToken = getAssociatedTokenAddressSync(USDC_MINT, bettor);
  const stake = new BN(Math.round(stakeUsdc * 1_000_000));

  const errors: string[] = [];
  for (const houseKey of quotes.best[outcome]) {
    const house = new PublicKey(houseKey);
    const houseAcc = await (client.program.account as any).house.fetch(house);
    // route through the first registered frontend (demo)
    const frontends = await (client.program.account as any).frontend.all();
    if (!frontends.length) return NextResponse.json({ error: "no frontend" }, { status: 500 });
    const frontend = frontends[0].publicKey;

    const nonce = new BN(Date.now() + Math.floor(Math.random() * 1000));
    try {
      await client.program.methods
        .commitBet(new BN(fixtureId), outcome, stake, nonce, new BN(fixture.StartTime))
        .accounts({
          bettor,
          escrowVault: client.pdas.escrow(),
          bettorToken,
          frontend,
          house,
          houseVault: houseAcc.vault,
          exposure: client.pdas.exposure(house, BigInt(fixtureId)),
          bet: client.pdas.bet(bettor, BigInt(nonce.toString())),
        })
        .rpc();
      return NextResponse.json({
        bet: client.pdas.bet(bettor, BigInt(nonce.toString())).toBase58(),
        house: houseKey,
      });
    } catch (e) {
      errors.push(`${houseKey.slice(0, 8)}: ${(e as Error).message.slice(0, 120)}`);
      // InsufficientHouseCollateral / caps -> try the next-best house
    }
  }
  return NextResponse.json({ error: errors.join(" | ") }, { status: 409 });
}
