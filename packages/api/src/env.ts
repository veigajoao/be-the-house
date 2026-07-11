import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import { Keypair } from "@solana/web3.js";

const ROOT = resolve(import.meta.dirname, "../../..");
dotenv({ path: resolve(ROOT, ".env") });

export const env = {
  /** RPC the keeper/API act on (a surfnet in demo mode, mainnet otherwise). */
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:18899",
  /** Real mainnet RPC — used to refresh cloned oracle roots into a surfnet. */
  mainnetRpcUrl: process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  /** When true, the RPC is a surfpool fork: refresh root PDAs before proving. */
  surfnetMode: (process.env.SURFNET_MODE ?? "true") === "true",
  port: Number(process.env.API_PORT ?? 8787),
  keeperIntervalMs: Number(process.env.KEEPER_INTERVAL_MS ?? 5_000),
  keeperKeypair: (process.env.KEEPER_KEYPAIR ?? process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json").replace(
    /^~/,
    process.env.HOME ?? "~",
  ),
  competitionId: process.env.COMPETITION_ID ? Number(process.env.COMPETITION_ID) : 72, // World Cup
};

export function loadKeeper(): Keypair {
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync(env.keeperKeypair, "utf8"))),
  );
}

export const IDL_PATH = resolve(ROOT, "target/idl/bethehouse.json");
export function loadIdl() {
  return JSON.parse(readFileSync(IDL_PATH, "utf8"));
}
