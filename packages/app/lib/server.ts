// Server-side chain access for the app. Works both locally (keypair file)
// and on Vercel (DEMO_KEYPAIR_JSON env var, IDL bundled with the app).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import { utils } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { BthClient } from "@bethehouse/sdk";
import { TxLineClient } from "@bethehouse/txline";
import idl from "./idl/bethehouse.json";

// Local dev: pick up the monorepo root .env (TxLINE creds, RPC, keypair path)
// wherever the dev server was launched from. On Vercel these no-op and env
// vars come from the project settings.
dotenv({ path: resolve(process.cwd(), "../../.env") });
dotenv({ path: resolve(process.cwd(), ".env") });

let cached: { client: BthClient } | null = null;
let txlineCached: TxLineClient | null = null;

/** Build a Keypair from raw secret bytes: 64 = full secret key, 32 = seed. */
function keypairFromBytes(bytes: Uint8Array): Keypair {
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  return Keypair.fromSecretKey(bytes);
}

function loadSigner(): Keypair {
  // Preferred (Vercel): a base58 private key — the format Phantom/Solflare
  // "export private key" gives you. Simplest to paste into an env var.
  if (process.env.DEMO_PRIVATE_KEY) {
    return keypairFromBytes(utils.bytes.bs58.decode(process.env.DEMO_PRIVATE_KEY.trim()));
  }
  // Also accepted: the raw keypair JSON array ([12,34,…], solana-keygen format).
  if (process.env.DEMO_KEYPAIR_JSON) {
    return keypairFromBytes(new Uint8Array(JSON.parse(process.env.DEMO_KEYPAIR_JSON)));
  }
  // Local dev: a keypair file path.
  const path = (process.env.DEMO_BETTOR_KEYPAIR ?? process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json").replace(
    /^~/,
    process.env.HOME ?? "~",
  );
  return keypairFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

export function chain(): { client: BthClient } {
  if (cached) return cached;
  const rpcUrl = process.env.RPC_URL ?? process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  cached = {
    client: new BthClient(new Connection(rpcUrl, "confirmed"), idl as never, loadSigner()),
  };
  return cached;
}

export function txline(): TxLineClient {
  txlineCached ??= TxLineClient.fromEnv();
  return txlineCached;
}
