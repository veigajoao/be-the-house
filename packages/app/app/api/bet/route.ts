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

  // Anchor custom error codes (see programs/bethehouse/src/errors.rs order).
  const CAPACITY_ERRORS = new Set([6007, 6008, 6009]); // collateral / per-fixture / total risk
  const PAUSED = 6002;
  const PAST_KICKOFF = 6006;
  const customCode = (err: unknown): number | null => {
    const ie = (err as any)?.InstructionError;
    return Array.isArray(ie) && ie[1]?.Custom != null ? (ie[1].Custom as number) : null;
  };

  let capacityBlocked = false;
  let bestMaxStakeUsdc = 0; // largest stake any house could take on this fixture
  const errors: string[] = [];

  for (const houseKey of quotes.best[outcome]) {
    const house = new PublicKey(houseKey);
    const houseAcc = await (client.program.account as any).house.fetch(house);

    // headroom this house has for THIS fixture's outcome (conservative: assume
    // the reservation adds fully to locked) → the max stake it could accept
    let fixtureLocked = 0;
    try {
      const exp = await (client.program.account as any).fixtureExposure.fetch(
        client.pdas.exposure(house, BigInt(fixtureId)),
      );
      fixtureLocked = exp.locked.toNumber();
    } catch {
      /* no exposure yet → 0 */
    }
    const vaultBal = Number((await client.connection.getTokenAccountBalance(houseAcc.vault)).value.amount);
    const capacity = Math.max(
      0,
      Math.min(
        houseAcc.maxRiskPerFixture.toNumber() - fixtureLocked,
        houseAcc.maxTotalRisk.toNumber() - houseAcc.totalLocked.toNumber(),
        vaultBal - houseAcc.totalLocked.toNumber(),
      ),
    );
    // reserved = stake * odds_cap / 1000 ≤ capacity → stake ≤ capacity*1000/odds_cap
    const maxStake = Math.floor((capacity * 1000) / houseAcc.oddsCap) / 1e6;
    bestMaxStakeUsdc = Math.max(bestMaxStakeUsdc, maxStake);

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

    const sim = await client.connection.simulateTransaction(tx, undefined, false);
    if (sim.value.err) {
      const code = customCode(sim.value.err);
      const logs = (sim.value.logs ?? []).join(" ");
      // the user's own funding is not a house problem — fail fast with guidance
      if (/insufficient lamports|debit an account/i.test(logs) || code === null) {
        return NextResponse.json(
          { error: "Your wallet needs devnet SOL + USDC — hit the faucet first." },
          { status: 402 },
        );
      }
      if (code === PAST_KICKOFF) {
        return NextResponse.json({ error: "This match has already kicked off." }, { status: 409 });
      }
      if (code === PAUSED) {
        errors.push(`house ${houseAcc.houseId} paused`);
        continue;
      }
      if (CAPACITY_ERRORS.has(code)) {
        capacityBlocked = true;
        continue; // try the next-best house
      }
      errors.push(`house ${houseAcc.houseId}: program error ${code}`);
      continue;
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

  if (capacityBlocked) {
    const max = Math.floor(bestMaxStakeUsdc);
    return NextResponse.json(
      {
        error:
          max > 0
            ? `Stake too large for the available houses — max about ${max} USDC on this outcome right now. Try a smaller amount.`
            : "The houses are at capacity on this outcome right now — try another outcome or a smaller stake.",
        maxStakeUsdc: max,
      },
      { status: 409 },
    );
  }
  return NextResponse.json({ error: errors.join(" · ") || "no house could take this bet" }, { status: 409 });
}
