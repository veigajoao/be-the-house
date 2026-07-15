// Shared end-to-end flow helpers for the fill/settle suites.
import * as anchorNs from "@coral-xyz/anchor";
// CJS/ESM interop: under plain node/tsx the CJS re-exports (BN, web3, ...)
// live on the namespace's `default`; under vitest they're flattened.
const anchor: typeof anchorNs = ((anchorNs as unknown as { default?: typeof anchorNs }).default ?? anchorNs) as typeof anchorNs;
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import type { Surfnet } from "./surfpool.js";
import {
  createLookupTable,
  fundActor,
  initProtocol,
  patchBet,
  pda,
  PROGRAM_ID,
  sendV0,
  TXORACLE_PROGRAM,
  USDC_MINT,
  type Actor,
  type Protocol,
} from "./setup.js";
import { oddsRootPda, scoresRootPda, type OddsPair } from "./fixtures.js";

export const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
export const USDC = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

export interface Market {
  protocol: Protocol;
  houseOwner: Actor;
  frontendOwner: Actor;
  bettor: Actor;
  cranker: Actor;
  house: PublicKey;
  houseVault: PublicKey;
  frontend: PublicKey;
  frontendFeeVault: PublicKey;
}

export interface HouseParamsInput {
  spreadBps: number;
  skewCoeffBps: number;
  oddsCap: number;
  maxRiskPerFixture: anchor.BN;
  maxTotalRisk: anchor.BN;
}

export const DEFAULT_HOUSE: HouseParamsInput = {
  spreadBps: 100,
  skewCoeffBps: 0,
  oddsCap: 15_000,
  maxRiskPerFixture: new anchor.BN(2_000_000_000),
  maxTotalRisk: new anchor.BN(4_000_000_000),
};

export async function setupMarket(
  surfnet: Surfnet,
  houseParams: Partial<HouseParamsInput> = {},
  frontendFeeBps = 200,
): Promise<Market> {
  const protocol = await initProtocol(surfnet);
  const houseOwner = await fundActor(surfnet, 10_000_000_000n);
  const frontendOwner = await fundActor(surfnet, 0n);
  const bettor = await fundActor(surfnet, 1_000_000_000n);
  const cranker = await fundActor(surfnet, 1_000_000n);

  await frontendOwner.program.methods
    .registerFrontend(frontendFeeBps)
    .accounts({ owner: frontendOwner.pubkey, usdcMint: USDC_MINT })
    .rpc();

  const params = { ...DEFAULT_HOUSE, ...houseParams };
  await houseOwner.program.methods
    .createHouse(1, params)
    .accounts({ owner: houseOwner.pubkey, usdcMint: USDC_MINT })
    .rpc();
  const house = pda.house(houseOwner.pubkey, 1);
  const houseVault = pda.houseVault(houseOwner.pubkey, 1);
  await houseOwner.program.methods
    .deposit(new anchor.BN(4_000_000_000))
    .accounts({
      depositor: houseOwner.pubkey,
      house,
      vault: houseVault,
      depositorToken: houseOwner.usdc,
    })
    .rpc();

  return {
    protocol,
    houseOwner,
    frontendOwner,
    bettor,
    cranker,
    house,
    houseVault,
    frontend: pda.frontend(frontendOwner.pubkey),
    frontendFeeVault: pda.frontendVault(frontendOwner.pubkey),
  };
}

/** Create an additional house (id) under the market's houseOwner. */
export async function addHouse(
  m: Market,
  id: number,
  params: Partial<HouseParamsInput>,
  depositUsdc: number,
): Promise<{ house: PublicKey; vault: PublicKey }> {
  await m.houseOwner.program.methods
    .createHouse(id, { ...DEFAULT_HOUSE, ...params })
    .accounts({ owner: m.houseOwner.pubkey, usdcMint: USDC_MINT })
    .rpc();
  const house = pda.house(m.houseOwner.pubkey, id);
  const vault = pda.houseVault(m.houseOwner.pubkey, id);
  await m.houseOwner.program.methods
    .deposit(USDC(depositUsdc))
    .accounts({
      depositor: m.houseOwner.pubkey,
      house,
      vault,
      depositorToken: m.houseOwner.usdc,
    })
    .rpc();
  return { house, vault };
}

// ~770-byte proofs only fit the tx limit with static accounts behind an ALT.
const lutCache = new Map<string, AddressLookupTableAccount>();

async function proveLut(
  surfnet: Surfnet,
  m: Market,
  pair: OddsPair,
): Promise<AddressLookupTableAccount> {
  const key = `${surfnet.rpcUrl}:${pair.fixtureId}`;
  const cached = lutCache.get(key);
  if (cached) return cached;
  const lut = await createLookupTable(surfnet, m.cranker.keypair, [
    PROGRAM_ID,
    TXORACLE_PROGRAM,
    ComputeBudgetProgram.programId,
    SystemProgram.programId,
    pda.config(),
    oddsRootPda(pair.commitPrint.raw.odds.Ts),
    oddsRootPda(pair.targetPrint.raw.odds.Ts),
  ]);
  lutCache.set(key, lut);
  return lut;
}

/** Prove both prints of a pair via v0 txs (skips ones already proven). */
export async function provePair(surfnet: Surfnet, m: Market, pair: OddsPair): Promise<void> {
  const lut = await proveLut(surfnet, m, pair);
  for (const print of [pair.commitPrint, pair.targetPrint]) {
    const printPda = pda.print(pair.fixtureId, print.raw.odds.Ts);
    const existing = await surfnet.connection.getAccountInfo(printPda);
    if (existing) continue;
    const ix = await m.cranker.program.methods
      .provePrint(
        print.args.odds,
        print.args.summary,
        print.args.subTreeProof,
        print.args.mainTreeProof,
      )
      .accounts({
        cranker: m.cranker.pubkey,
        oddsRoot: oddsRootPda(print.raw.odds.Ts),
        txoracleProgram: TXORACLE_PROGRAM,
      })
      .instruction();
    await sendV0(surfnet, m.cranker.keypair, [CU, ix], lut);
  }
}

let nonce = 1000n;

export interface CommittedBet {
  bet: PublicKey;
  exposure: PublicKey;
  nonce: bigint;
}

/**
 * Commit and time-shift the bet so the pair's prints land in the fill
 * windows: commit = recommendedCommitTsMs (print1 + 30s), target = +15s.
 */
export async function commitOnPair(
  surfnet: Surfnet,
  m: Market,
  pair: OddsPair,
  opts: Partial<{
    outcome: number;
    stakeUsdc: number;
    house: PublicKey;
    houseVault: PublicKey;
    frontend: PublicKey;
    commitTsMs: number;
    startTimeMs: number;
  }> = {},
): Promise<CommittedBet> {
  const n = ++nonce;
  const house = opts.house ?? m.house;
  const houseVault = opts.houseVault ?? m.houseVault;
  const frontend = opts.frontend ?? m.frontend;
  const fixture = BigInt(pair.fixtureId);
  // real "now" start_time so commit passes; patched below
  const clock = await surfnet.connection.getAccountInfo(
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
  );
  const nowMs = Number(clock!.data.readBigInt64LE(32)) * 1000;

  await m.bettor.program.methods
    .commitBet(
      new anchor.BN(fixture.toString()),
      opts.outcome ?? 0,
      USDC(opts.stakeUsdc ?? 10),
      new anchor.BN(n.toString()),
      new anchor.BN(nowMs + 24 * 3600 * 1000),
    )
    .accounts({
      bettor: m.bettor.pubkey,
      escrowVault: m.protocol.escrow,
      bettorToken: m.bettor.usdc,
      frontend,
      house,
      houseVault,
      exposure: pda.exposure(house, fixture),
      bet: pda.bet(m.bettor.pubkey, n),
    })
    .rpc();

  const bet = pda.bet(m.bettor.pubkey, n);
  const commitTsMs = opts.commitTsMs ?? pair.recommendedCommitTsMs;
  await patchBet(surfnet, m.bettor.program, bet, {
    commitTsMs,
    targetTsMs: commitTsMs + 15_000,
    // keep kickoff after both prints (pre-match check) unless overridden
    startTimeMs: opts.startTimeMs ?? pair.targetPrint.raw.odds.Ts + 3_600_000,
  });
  return { bet, exposure: pda.exposure(house, fixture), nonce: n };
}

export function settleIx(
  m: Market,
  c: CommittedBet,
  payload: Parameters<ReturnType<Market["cranker"]["program"]["methods"]["settleBet"]>>[never] | any,
  opts: Partial<{ house: PublicKey; houseVault: PublicKey }> = {},
) {
  return m.cranker.program.methods
    .settleBet(payload)
    .accounts({
      cranker: m.cranker.pubkey,
      crankerToken: m.cranker.usdc,
      escrowVault: m.protocol.escrow,
      bet: c.bet,
      house: opts.house ?? m.house,
      houseVault: opts.houseVault ?? m.houseVault,
      exposure: c.exposure,
      bettorToken: m.bettor.usdc,
      scoresRoot: scoresRootPda(Number(payload.fixtureSummary.updateStats.minTimestamp)),
      txoracleProgram: TXORACLE_PROGRAM,
    })
    .preInstructions([CU]);
}

export function fillIx(
  m: Market,
  c: CommittedBet,
  pair: OddsPair,
  opts: Partial<{
    house: PublicKey;
    houseVault: PublicKey;
    frontend: PublicKey;
    frontendFeeVault: PublicKey;
  }> = {},
) {
  return m.cranker.program.methods
    .fillBet()
    .accounts({
      cranker: m.cranker.pubkey,
      crankerToken: m.cranker.usdc,
      escrowVault: m.protocol.escrow,
      bet: c.bet,
      house: opts.house ?? m.house,
      houseVault: opts.houseVault ?? m.houseVault,
      exposure: c.exposure,
      frontend: opts.frontend ?? m.frontend,
      frontendFeeVault: opts.frontendFeeVault ?? m.frontendFeeVault,
      treasuryVault: m.protocol.treasury,
      commitPrint: pda.print(pair.fixtureId, pair.commitPrint.raw.odds.Ts),
      targetPrint: pda.print(pair.fixtureId, pair.targetPrint.raw.odds.Ts),
    });
}
