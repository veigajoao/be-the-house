// Airdrop test USDC to any wallet (devnet). The admin keypair is the mint
// authority of the test mint, so this mints directly — no rate limits.
//
//   npx tsx scripts/airdrop-usdc.ts <wallet-address> [amountUsdc=1000]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const ROOT = resolve(import.meta.dirname, "..");
dotenv({ path: resolve(ROOT, ".env") });

const [toArg, amountArg] = process.argv.slice(2);
if (!toArg) {
  console.log("usage: npx tsx scripts/airdrop-usdc.ts <wallet-address> [amountUsdc=1000]");
  process.exit(1);
}
const to = new PublicKey(toArg);
const amountUsdc = Number(amountArg ?? 1000);
const mint = new PublicKey(process.env.USDC_MINT ?? "ETnaYN2P3WnH1ZRgCVPbGmNsZ3g7DuJwX8t77czxAyw6");
const rpc = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";

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
const conn = new Connection(rpc, "confirmed");
const ata = getAssociatedTokenAddressSync(mint, to);
const tx = new Transaction()
  .add(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, ata, to, mint))
  .add(createMintToInstruction(mint, ata, admin.publicKey, BigInt(Math.round(amountUsdc * 1e6))));
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.feePayer = admin.publicKey;
tx.sign(admin);
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, "confirmed");
console.log(`airdropped ${amountUsdc} USDC to ${to.toBase58()}`);
console.log(`tx: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
