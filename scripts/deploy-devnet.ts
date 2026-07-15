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
export const DEVNET_USDC = process.env.DEVNET_USDC ?? "ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6";
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
      stalenessWindowMs: new anchor.BN(120_000),
      fillToleranceMs: new anchor.BN(90_000),
      commitExpiryMs: new anchor.BN(3_600_000),
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
if (bal < 10_000_000_000n) {
  await mintTo(connection, admin, usdcMint, adminAta, admin, 20_000_000_000n); // 20k USDC
  log("minted 20,000 test USDC to admin");
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

// ---- 4. houses: sharp (80 bps) + wide (300 bps) ----
for (const [id, name, spread] of [
  [1, "sharp", 80],
  [2, "wide", 300],
] as const) {
  const housePda = client.pdas.house(admin.publicKey, id);
  if (await connection.getAccountInfo(housePda)) {
    log(`house "${name}" already exists:`, housePda.toBase58());
    continue;
  }
  await client.program.methods
    .createHouse(id, {
      spreadBps: spread,
      skewCoeffBps: 2_000,
      oddsCap: 15_000,
      maxRiskPerFixture: USDC(2_000),
      maxTotalRisk: USDC(4_000),
    })
    .accounts({ owner: admin.publicKey, usdcMint })
    .rpc();
  await client.program.methods
    .deposit(USDC(4_000))
    .accounts({
      depositor: admin.publicKey,
      house: housePda,
      vault: client.pdas.houseVault(admin.publicKey, id),
      depositorToken: adminAta,
    })
    .rpc();
  log(`house "${name}" created (${spread} bps) + 4,000 USDC deposited:`, housePda.toBase58());
}

log("");
log("=== DONE — run the stack with: ===");
log(`RPC_URL=${rpcUrl} SURFNET_MODE=false TXLINE_ENV=development \\`);
log(`TXORACLE_PROGRAM=${DEVNET_TXORACLE} USDC_MINT=${DEVNET_USDC} \\`);
log("npx tsx packages/api/src/index.ts");
log("");
log("frontend: cd packages/app && \\");
log(`RPC_URL=${rpcUrl} TXORACLE_PROGRAM=${DEVNET_TXORACLE} USDC_MINT=${DEVNET_USDC} \\`);
log("NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 pnpm dev");
