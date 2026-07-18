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
import { chargeForStake, feeModel, stakeForCharge } from "../../../lib/fees";

export async function POST(req: NextRequest) {
  // `spendUsdc` is the fee-INCLUSIVE amount the bettor wants charged. We invert
  // it to the on-chain stake so the total debit equals the slip's headline.
  const { fixtureId, outcome, stakeUsdc: spendUsdc, bettor: bettorStr } = (await req.json()) as {
    fixtureId: number;
    outcome: number;
    stakeUsdc: number;
    bettor: string;
  };
  if (!bettorStr) return NextResponse.json({ error: "connect a wallet" }, { status: 400 });
  const bettor = new PublicKey(bettorStr);
  const { client } = chain();

  const [fixtures, quotes, config] = await Promise.all([
    getFixtures(),
    getQuotes(fixtureId),
    (client.program.account as any).config.fetch(client.pdas.config()),
  ]);
  const fixture = fixtures.find((f) => f.FixtureId === fixtureId);
  if (!fixture) return NextResponse.json({ error: "unknown fixture" }, { status: 404 });
  if (!quotes) return NextResponse.json({ error: "no live quotes" }, { status: 409 });

  const frontends = await (client.program.account as any).frontend.all();
  if (!frontends.length) return NextResponse.json({ error: "no frontend" }, { status: 500 });
  const frontend = frontends[0].publicKey;

  const fees = feeModel({
    frontendFeeBps: frontends[0].account.feeBps,
    protocolFeeBps: config.protocolFeeBps,
    keeperReward: config.keeperReward.toNumber(),
  });
  const spendUusdc = Math.round(spendUsdc * 1_000_000);
  const stakeUusdc = stakeForCharge(spendUusdc, fees);
  if (stakeUusdc <= 0) {
    return NextResponse.json(
      { error: `Too small — the ${(fees.keeperUusdc / 1e6).toFixed(0)} USDC keeper fee eats it all. Bet a bit more.` },
      { status: 400 },
    );
  }
  const stake = new BN(stakeUusdc);
  const bettorToken = getAssociatedTokenAddressSync(USDC_MINT, bettor);
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
  let bestMaxSpendUsdc = 0; // largest fee-inclusive spend any house could take on this fixture
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
    // reserved = stake * odds_cap / 1000 ≤ capacity → stake ≤ capacity*1000/odds_cap.
    // Report the fee-inclusive spend that maps to that max stake, so guidance
    // matches what the bettor types into the box.
    const maxStakeUusdc = Math.floor((capacity * 1000) / houseAcc.oddsCap);
    const maxSpendUsdc = chargeForStake(maxStakeUusdc, fees) / 1e6;
    bestMaxSpendUsdc = Math.max(bestMaxSpendUsdc, maxSpendUsdc);

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
    const max = Math.floor(bestMaxSpendUsdc);
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
