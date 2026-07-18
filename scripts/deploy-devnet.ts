// One-shot devnet bootstrap (run AFTER `solana program deploy ... -u devnet`):
//   init_config (devnet txoracle + test USDC mint) -> register frontend ->
//   create sharp/wide houses -> mint test USDC -> deposit collateral.
// Idempotent-ish: skips steps whose accounts already exist.
//
//   npx tsx scripts/deploy-devnet.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";

const ROOT = resolve(import.meta.dirname, "..");
dotenv({ path: resolve(ROOT, ".env") });

// devnet identities — set BEFORE importing the sdk (read at module load)
export const DEVNET_TXORACLE = "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J";
export const DEVNET_USDC = process.env.DEVNET_USDC ?? "5Nr5hRv9wGWW4ChEtay5PjK4pdYXsVuCzh5JTYztW58Y";
process.env.TXORACLE_PROGRAM = DEVNET_TXORACLE;
process.env.USDC_MINT = DEVNET_USDC;

import * as anchorNs from "@coral-xyz/anchor";
const anchor: typeof anchorNs = ((anchorNs as unknown as { default?: typeof anchorNs }).default ??
  anchorNs) as typeof anchorNs;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";

const { BthClient } = await import("../packages/sdk/src/client.js");

const log = (...a: unknown[]) => console.log("[devnet-bootstrap]", ...a);
const USDC = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

const rpcUrl = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(rpcUrl, "confirmed");
const admin = Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      readFileSync(
        (process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, process.env.HOME!),
        "utf8",
      ),
    ),
  ),
);
const idl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/bethehouse.json"), "utf8"));
const client = new BthClient(connection, idl, admin);
const usdcMint = new PublicKey(DEVNET_USDC);

log("cluster:", rpcUrl);
log("admin:", admin.publicKey.toBase58(), `(${(await connection.getBalance(admin.publicKey)) / 1e9} SOL)`);
log("program:", client.program.programId.toBase58());
log("txoracle (devnet):", DEVNET_TXORACLE);
log("test USDC mint:", DEVNET_USDC);

// ---- 1. config ----
const configPda = client.pdas.config();
if (await connection.getAccountInfo(configPda)) {
  log("config already initialized:", configPda.toBase58());
} else {
  await client.program.methods
    .initConfig({
      protocolFeeBps: 100,
      maxFrontendFeeBps: 500,
      keeperReward: USDC(1),
      commitDelayMs: new anchor.BN(15_000),
      // Widened for devnet's bursty feed (prints can be ~50 min apart): the
      // prove/fill windows and refund deadline must exceed the worst gap.
      stalenessWindowMs: new anchor.BN(7_200_000), // 2h prove window
      fillToleranceMs: new anchor.BN(7_200_000), // 2h fill window
      commitExpiryMs: new anchor.BN(10_800_000), // 3h before refund
      voidAfterMs: new anchor.BN(3 * 86_400_000),
    })
    .accounts({
      admin: admin.publicKey,
      usdcMint,
      txoracleProgram: new PublicKey(DEVNET_TXORACLE),
    })
    .rpc();
  log("config initialized:", configPda.toBase58());
}

// ---- 2. test USDC for the admin (mint authority = admin) ----
const adminAta = getAssociatedTokenAddressSync(usdcMint, admin.publicKey);
await createAssociatedTokenAccountIdempotent(connection, admin, usdcMint, admin.publicKey);
const bal = BigInt((await connection.getTokenAccountBalance(adminAta)).value.amount);
if (bal < 1_000_000_000_000n) {
  // 1.05M: 1M for the core pool + demo houses + a spare buffer to place bets
  await mintTo(connection, admin, usdcMint, adminAta, admin, 1_050_000_000_000n);
  log("minted 1,050,000 test USDC to admin");
}

// ---- 3. frontend ----
const frontendPda = client.pdas.frontend(admin.publicKey);
if (await connection.getAccountInfo(frontendPda)) {
  log("frontend already registered:", frontendPda.toBase58());
} else {
  await client.program.methods
    .registerFrontend(100)
    .accounts({ owner: admin.publicKey, usdcMint })
    .rpc();
  log("frontend registered (100 bps):", frontendPda.toBase58());
}

// ---- 4. houses ----
//   core (id 1): the main 1,000,000-USDC pool owned by the admin — deep enough
//     to back any bet on the book. sharp/wide are small demo books for routing
//     variety (best-price competition across houses).
const HOUSES = [
  { id: 1, name: "core", spread: 150, maxFixture: 200_000, maxTotal: 1_000_000, deposit: 1_000_000 },
  { id: 2, name: "sharp", spread: 80, maxFixture: 2_000, maxTotal: 4_000, deposit: 4_000 },
  { id: 3, name: "wide", spread: 300, maxFixture: 2_000, maxTotal: 4_000, deposit: 4_000 },
] as const;
for (const h of HOUSES) {
  const housePda = client.pdas.house(admin.publicKey, h.id);
  if (await connection.getAccountInfo(housePda)) {
    log(`house "${h.name}" already exists:`, housePda.toBase58());
    continue;
  }
  await client.program.methods
    .createHouse(h.id, {
      spreadBps: h.spread,
      skewCoeffBps: 2_000,
      oddsCap: 15_000,
      maxRiskPerFixture: USDC(h.maxFixture),
      maxTotalRisk: USDC(h.maxTotal),
    })
    .accounts({ owner: admin.publicKey, usdcMint })
    .rpc();
  await client.program.methods
    .deposit(USDC(h.deposit))
    .accounts({
      depositor: admin.publicKey,
      house: housePda,
      vault: client.pdas.houseVault(admin.publicKey, h.id),
      depositorToken: adminAta,
    })
    .rpc();
  log(`house "${h.name}" created (${h.spread} bps) + ${h.deposit.toLocaleString()} USDC deposited:`, housePda.toBase58());
}

log("");
log("=== DONE — run the app (UI + API + cron keeper route) with: ===");
log("cd packages/app && \\");
log(`RPC_URL=${rpcUrl} TXLINE_ENV=development SURFNET_MODE=false \\`);
log(`TXORACLE_PROGRAM=${DEVNET_TXORACLE} USDC_MINT=${DEVNET_USDC} pnpm dev`);
log("keeper: schedule GET /api/cron/keeper (Vercel Cron in prod; curl loop locally)");
