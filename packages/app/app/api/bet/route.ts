// Build an UNSIGNED commit_bet transaction for the connected wallet to sign.
// Keeps server-side next-best-house routing: we simulate the tx against each
// house in best-odds order and return the first that would succeed (this
// mirrors the on-chain collateral/netting checks without trial-sending).
import { NextRequest, NextResponse } from "next/server";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";
import { getFixtures, getQuotes } from "../../../lib/market";

export async function POST(req: NextRequest) {
  const { fixtureId, outcome, stakeUsdc, bettor: bettorStr } = (await req.json()) as {
    fixtureId: number;
    outcome: number;
    stakeUsdc: number;
    bettor: string;
  };
  if (!bettorStr) return NextResponse.json({ error: "connect a wallet" }, { status: 400 });
  const bettor = new PublicKey(bettorStr);
  const { client } = chain();

  const [fixtures, quotes] = await Promise.all([getFixtures(), getQuotes(fixtureId)]);
  const fixture = fixtures.find((f) => f.FixtureId === fixtureId);
  if (!fixture) return NextResponse.json({ error: "unknown fixture" }, { status: 404 });
  if (!quotes) return NextResponse.json({ error: "no live quotes" }, { status: 409 });

  const frontends = await (client.program.account as any).frontend.all();
  if (!frontends.length) return NextResponse.json({ error: "no frontend" }, { status: 500 });
  const frontend = frontends[0].publicKey;

  const bettorToken = getAssociatedTokenAddressSync(USDC_MINT, bettor);
  const stake = new BN(Math.round(stakeUsdc * 1_000_000));
  const { blockhash } = await client.connection.getLatestBlockhash();

  const errors: string[] = [];
  for (const houseKey of quotes.best[outcome]) {
    const house = new PublicKey(houseKey);
    const houseAcc = await (client.program.account as any).house.fetch(house);
    const nonce = new BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const betPda = client.pdas.bet(bettor, BigInt(nonce.toString()));

    const tx = await client.program.methods
      .commitBet(new BN(fixtureId), outcome, stake, nonce, new BN(fixture.StartTime))
      .accounts({
        bettor,
        escrowVault: client.pdas.escrow(),
        bettorToken,
        frontend,
        house,
        houseVault: houseAcc.vault,
        exposure: client.pdas.exposure(house, BigInt(fixtureId)),
        bet: betPda,
      })
      .transaction();
    tx.feePayer = bettor;
    tx.recentBlockhash = blockhash;

    // simulate (no signature needed) — catches collateral/caps/kickoff/funds
    const sim = await client.connection.simulateTransaction(tx, undefined, false);
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).join(" ");
      // insufficient SOL/USDC is the user's own funding, not a house problem
      if (/insufficient lamports|insufficient funds|debit an account/i.test(logs)) {
        return NextResponse.json(
          { error: "Your wallet needs devnet SOL + USDC — hit the faucet first." },
          { status: 402 },
        );
      }
      errors.push(`${houseKey.slice(0, 6)}: ${logs.slice(-120) || JSON.stringify(sim.value.err)}`);
      continue; // try the next-best house
    }

    const best = quotes.quotes.find((q) => q.house === houseKey)!;
    return NextResponse.json({
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      bet: betPda.toBase58(),
      house: houseKey,
      houseId: best.houseId,
      spreadBps: best.spreadBps,
      ceiling: best.effOdds[outcome],
      oddsCap: best.oddsCap,
    });
  }
  return NextResponse.json({ error: errors.join(" | ") || "no house could take this bet" }, { status: 409 });
}
