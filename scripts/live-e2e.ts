// M4 live end-to-end: real TxLINE mainnet feed -> commit at live odds ->
// keeper proves prints + fills on a surfpool mainnet fork. No patched
// timestamps: the bet is committed the moment a fresh StablePrice print
// lands, so the commit window holds naturally; the fill lands once the
// target print's 5-min batch root publishes (~0.5-5.5 min).
//
// Usage: npx tsx scripts/live-e2e.ts [fixtureId]
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import * as anchorNs from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

// CJS/ESM interop under tsx (see tests/harness/setup.ts)
const anchor: typeof anchorNs = ((anchorNs as unknown as { default?: typeof anchorNs }).default ??
  anchorNs) as typeof anchorNs;

const ROOT = resolve(import.meta.dirname, "..");
dotenv({ path: resolve(ROOT, ".env") });
process.env.SURFPOOL_BASE_PORT = process.env.LIVE_E2E_PORT ?? "18999";

const { startSurfnet } = await import("../tests/harness/surfpool.js");
const { initProtocol, fundActor, pda, usdcBalance, USDC_MINT } = await import(
  "../tests/harness/setup.js"
);
const { TxLineClient, MARKET_1X2, STABLE_PRICE_BOOKMAKER_ID } = await import(
  "../packages/txline/src/index.js"
);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[e2e]", ...a);
const USDC = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

const txline = TxLineClient.fromEnv();

// -- pick a fixture: arg, or the next kickoff with live stable quoting --
let fixtureId = process.argv[2] ? Number(process.argv[2]) : 0;
const fixtures = await txline.fixtures();
if (!fixtureId) {
  const now = Date.now();
  for (const f of fixtures
    .filter((f) => f.StartTime > now + 20 * 60_000)
    .sort((a, b) => a.StartTime - b.StartTime)) {
    try {
      const u = await txline.oddsUpdates(f.FixtureId);
      const stable = u.filter(
        (r) =>
          r.SuperOddsType === MARKET_1X2 &&
          r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
          !r.MarketPeriod &&
          !r.InRunning,
      );
      if (stable.length && now - Math.max(...stable.map((r) => r.Ts)) < 30 * 60_000) {
        fixtureId = f.FixtureId;
        break;
      }
    } catch {
      /* no odds coverage */
    }
  }
}
if (!fixtureId) {
  log("no upcoming fixture with live StablePrice quoting — try again later");
  process.exit(2);
}
const fixture = fixtures.find((f) => f.FixtureId === fixtureId)!;
log(
  `fixture ${fixtureId}: ${fixture.Participant1} v ${fixture.Participant2}, ` +
    `kickoff ${new Date(fixture.StartTime).toISOString()}`,
);

// -- surfnet + protocol --
const surfnet = await startSurfnet();
log("surfnet up at", surfnet.rpcUrl);
const protocol = await initProtocol(surfnet);
const houseOwner = await fundActor(surfnet, 10_000_000_000n);
const frontendOwner = await fundActor(surfnet, 0n);
const bettor = await fundActor(surfnet, 1_000_000_000n);

await frontendOwner.program.methods
  .registerFrontend(200)
  .accounts({ owner: frontendOwner.pubkey, usdcMint: USDC_MINT })
  .rpc();
await houseOwner.program.methods
  .createHouse(1, {
    spreadBps: 150,
    skewCoeffBps: 2_000,
    oddsCap: 15_000,
    maxRiskPerFixture: USDC(2_000),
    maxTotalRisk: USDC(4_000),
  })
  .accounts({ owner: houseOwner.pubkey, usdcMint: USDC_MINT })
  .rpc();
const house = pda.house(houseOwner.pubkey, 1);
const houseVault = pda.houseVault(houseOwner.pubkey, 1);
await houseOwner.program.methods
  .deposit(USDC(4_000))
  .accounts({
    depositor: houseOwner.pubkey,
    house,
    vault: houseVault,
    depositorToken: houseOwner.usdc,
  })
  .rpc();
log("protocol + house + frontend ready");

// -- keeper/api as a child process against the surfnet --
const api = spawn("npx", ["tsx", "packages/api/src/index.ts"], {
  cwd: ROOT,
  env: {
    ...process.env,
    RPC_URL: surfnet.rpcUrl,
    SURFNET_MODE: "true",
    API_PORT: "8788",
    KEEPER_INTERVAL_MS: "5000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.stdout.write(d));
api.stderr.on("data", (d) => process.stderr.write(d));

// -- commit whenever a fresh print lands (max 12 attempts), watch for a fill --
let nonce = BigInt(Math.floor(Math.random() * 1_000_000));
let lastCommittedPrintTs = 0;
let commits = 0;
const startedAt = Date.now();
const DEADLINE_MS = Number(process.env.LIVE_E2E_DEADLINE_MIN ?? 45) * 60_000;

async function latestPrint() {
  const u = await txline.oddsUpdates(fixtureId);
  const stable = u
    .filter(
      (r) =>
        r.SuperOddsType === MARKET_1X2 &&
        r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
        !r.MarketPeriod &&
        !r.InRunning,
    )
    .sort((a, b) => b.Ts - a.Ts);
  return stable[0];
}

async function pendingCount(): Promise<number> {
  const bets = await (bettor.program.account as any).bet.all();
  return bets.filter((b: any) => b.account.state.pending).length;
}

async function findActive(): Promise<{ pda: PublicKey; account: any } | null> {
  const bets = await (bettor.program.account as any).bet.all();
  const active = bets.find((b: any) => b.account.state.active);
  return active ? { pda: active.publicKey, account: active.account } : null;
}

for (;;) {
  const filled = await findActive();
  if (filled) {
    const a = filled.account;
    log("🎉 BET FILLED LIVE");
    log(`   bet: ${filled.pda.toBase58()}`);
    log(`   outcome ${a.outcome}, stake ${a.stake.toNumber() / 1e6} USDC`);
    log(`   fill odds ${(a.fillOdds / 1000).toFixed(3)} (x1000: ${a.fillOdds})`);
    log(`   payout ${a.payout.toNumber() / 1e6} USDC, fill print ts ${new Date(a.fillTsMs.toNumber()).toISOString()}`);
    log(`   bettor balance: ${Number(await usdcBalance(surfnet, bettor.usdc)) / 1e6} USDC`);
    api.kill();
    await surfnet.stop();
    process.exit(0);
  }

  if (Date.now() - startedAt > DEADLINE_MS) {
    log(`deadline reached without a fill (${commits} commits attempted) — exiting`);
    api.kill();
    await surfnet.stop();
    process.exit(1);
  }

  const print = await latestPrint();
  const age = print ? Date.now() - print.Ts : Infinity;
  if (print && age < 25_000 && print.Ts !== lastCommittedPrintTs && commits < 12 && (await pendingCount()) < 3) {
    lastCommittedPrintTs = print.Ts;
    commits++;
    nonce++;
    // bet on the favorite (lowest price) to keep reservations small
    const outcome = print.Prices.indexOf(Math.min(...print.Prices));
    await bettor.program.methods
      .commitBet(
        new anchor.BN(fixtureId),
        outcome,
        USDC(5),
        new anchor.BN(nonce.toString()),
        new anchor.BN(fixture.StartTime),
      )
      .accounts({
        bettor: bettor.pubkey,
        escrowVault: protocol.escrow,
        bettorToken: bettor.usdc,
        frontend: pda.frontend(frontendOwner.pubkey),
        house,
        houseVault,
        exposure: pda.exposure(house, BigInt(fixtureId)),
        bet: pda.bet(bettor.pubkey, nonce),
      })
      .rpc();
    log(
      `committed bet #${commits} on outcome ${outcome} at print age ${(age / 1000).toFixed(1)}s ` +
        `(ceiling ~${(print.Prices[outcome] / 1000).toFixed(3)}); waiting for target print + proofs`,
    );
  }

  await new Promise((r) => setTimeout(r, 5_000));
}
