// M5 demo: two houses with different spreads quoting the same fixture; a
// bettor gets quotes, commits with the best house, the keeper proves + fills
// at the T+15s print, and (when the game finishes) settles.
//
// Runs on a fresh surfpool mainnet fork with REAL live TxLINE data:
//   npx tsx scripts/demo.ts [fixtureId]
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import * as anchorNs from "@coral-xyz/anchor";

const ROOT = resolve(import.meta.dirname, "..");
dotenv({ path: resolve(ROOT, ".env") });
process.env.SURFPOOL_BASE_PORT = process.env.DEMO_PORT ?? "19199";

const anchor: typeof anchorNs = ((anchorNs as unknown as { default?: typeof anchorNs }).default ??
  anchorNs) as typeof anchorNs;

const { startSurfnet } = await import("../tests/harness/surfpool.js");
const { initProtocol, fundActor, pda, usdcBalance, USDC_MINT } = await import(
  "../tests/harness/setup.js"
);
const { TxLineClient, MARKET_1X2, STABLE_PRICE_BOOKMAKER_ID } = await import(
  "../packages/txline/src/index.js"
);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[demo]", ...a);
const USDC = (n: number) => new anchor.BN(Math.round(n * 1_000_000));
const fmt = (x1000: number) => (x1000 / 1000).toFixed(3);

const txline = TxLineClient.fromEnv();
const fixtureId = Number(process.argv[2] ?? 18222446);
const fixtures = await txline.fixtures();
const fixture = fixtures.find((f) => f.FixtureId === fixtureId);
if (!fixture) throw new Error(`fixture ${fixtureId} not found`);
log(`${fixture.Participant1} v ${fixture.Participant2}, kickoff ${new Date(fixture.StartTime).toISOString()}`);

// ---- infrastructure ----
const surfnet = await startSurfnet();
log("surfnet:", surfnet.rpcUrl);
const protocol = await initProtocol(surfnet);

// ---- two competing houses ----
const sharpOwner = await fundActor(surfnet, 10_000_000_000n);
const wideOwner = await fundActor(surfnet, 10_000_000_000n);
const frontendOwner = await fundActor(surfnet, 0n);
const bettor = await fundActor(surfnet, 1_000_000_000n);

await frontendOwner.program.methods
  .registerFrontend(100) // 1% frontend fee
  .accounts({ owner: frontendOwner.pubkey, usdcMint: USDC_MINT })
  .rpc();

async function makeHouse(owner: typeof sharpOwner, name: string, spreadBps: number) {
  await owner.program.methods
    .createHouse(1, {
      spreadBps,
      skewCoeffBps: 2_000,
      oddsCap: 15_000,
      maxRiskPerFixture: USDC(2_000),
      maxTotalRisk: USDC(4_000),
    })
    .accounts({ owner: owner.pubkey, usdcMint: USDC_MINT })
    .rpc();
  const house = pda.house(owner.pubkey, 1);
  const vault = pda.houseVault(owner.pubkey, 1);
  await owner.program.methods
    .deposit(USDC(4_000))
    .accounts({ depositor: owner.pubkey, house, vault, depositorToken: owner.usdc })
    .rpc();
  log(`house "${name}": spread ${spreadBps} bps, 4000 USDC collateral (${house.toBase58().slice(0, 8)}…)`);
  return { house, vault, name };
}
const sharp = await makeHouse(sharpOwner, "sharp", 80); // 0.8% spread
const wide = await makeHouse(wideOwner, "wide", 300); // 3% spread

// ---- API + keeper ----
const api = spawn("npx", ["tsx", "packages/api/src/index.ts"], {
  cwd: ROOT,
  env: { ...process.env, RPC_URL: surfnet.rpcUrl, SURFNET_MODE: "true", API_PORT: "8789", KEEPER_INTERVAL_MS: "5000" },
  stdio: ["ignore", "pipe", "pipe"],
});
api.stdout.on("data", (d) => process.stdout.write(d));
api.stderr.on("data", (d) => process.stderr.write(d));
await new Promise((r) => setTimeout(r, 3_000));

// ---- quotes: the SDK/API view the bettor sees ----
const quotesRes = await fetch(`http://127.0.0.1:8789/quotes/${fixtureId}`);
if (quotesRes.ok) {
  const q = (await quotesRes.json()) as any;
  log(`StablePrice print ts=${new Date(q.print.ts).toISOString()} prices [${q.print.prices.map(fmt).join(", ")}]`);
  for (const h of q.quotes) {
    log(`  quote ${h.house.slice(0, 8)}… spread ${h.spreadBps}bps -> up to [${h.effOdds.map(fmt).join(", ")}]`);
  }
} else {
  log("no live quotes yet (StablePrice not quoting this fixture right now)");
}

// ---- commit on fresh prints via the BEST house (auto = sharp) ----
let nonce = BigInt(Date.now());
let lastPrintTs = 0;
let commits = 0;
const startedAt = Date.now();
const DEADLINE_MS = Number(process.env.DEMO_DEADLINE_MIN ?? 45) * 60_000;

let announcedFill = false;
for (;;) {
  const bets = await (bettor.program.account as any).bet.all();
  const active = bets.find((b: any) => b.account.state.active);
  if (active && !announcedFill) {
    announcedFill = true;
    const a = active.account;
    const houseName = a.house.equals(sharp.house) ? "sharp" : "wide";
    log("🎉 FILLED at the T+15s print");
    log(`   house "${houseName}", outcome ${a.outcome}, stake ${a.stake.toNumber() / 1e6} USDC`);
    log(`   fill odds ${fmt(a.fillOdds)} -> payout ${a.payout.toNumber() / 1e6} USDC`);
    log(`   bettor balance ${Number(await usdcBalance(surfnet, bettor.usdc)) / 1e6} USDC`);
    log("   (settlement will crank automatically once the game finishes — leave this running, or Ctrl-C)");
    // keep running so the keeper can settle after full-time
  }
  const settled = bets.find((b: any) => b.account.state.won || b.account.state.lost);
  if (settled) {
    const a = settled.account;
    log(`🏁 SETTLED: ${a.state.won ? "WON" : "LOST"} — bettor balance ${Number(await usdcBalance(surfnet, bettor.usdc)) / 1e6} USDC`);
    api.kill();
    await surfnet.stop();
    process.exit(0);
  }
  if (Date.now() - startedAt > DEADLINE_MS && !active) {
    log("deadline without a fill — exiting (expired commits refund automatically)");
    api.kill();
    await surfnet.stop();
    process.exit(1);
  }

  if (!active) {
    const updates = await txline.oddsUpdates(fixtureId);
    const stable = updates
      .filter(
        (r) =>
          r.SuperOddsType === MARKET_1X2 &&
          r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
          !r.MarketPeriod &&
          !r.InRunning,
      )
      .sort((a, b) => b.Ts - a.Ts);
    const print = stable[0];
    const pending = bets.filter((b: any) => b.account.state.pending).length;
    if (print && Date.now() - print.Ts < 25_000 && print.Ts !== lastPrintTs && commits < 12 && pending < 3) {
      lastPrintTs = print.Ts;
      commits++;
      nonce++;
      const outcome = print.Prices.indexOf(Math.min(...print.Prices));
      await bettor.program.methods
        .commitBet(new anchor.BN(fixtureId), outcome, USDC(5), new anchor.BN(nonce.toString()), new anchor.BN(fixture.StartTime))
        .accounts({
          bettor: bettor.pubkey,
          escrowVault: protocol.escrow,
          bettorToken: bettor.usdc,
          frontend: pda.frontend(frontendOwner.pubkey),
          house: sharp.house,
          houseVault: sharp.vault,
          exposure: pda.exposure(sharp.house, BigInt(fixtureId)),
          bet: pda.bet(bettor.pubkey, nonce),
        })
        .rpc();
      log(`committed 5 USDC on outcome ${outcome} via "sharp" (ceiling ~${fmt(print.Prices[outcome])}, print age ${((Date.now() - print.Ts) / 1000).toFixed(1)}s)`);
    }
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
