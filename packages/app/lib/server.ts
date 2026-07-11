// Server-side chain access for the example app. Signs with a local demo
// keypair (hackathon surfnet demo — a wallet-adapter integration would
// replace this in production).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { BthClient } from "@bethehouse/sdk";

const ROOT = resolve(process.cwd(), "../..");

let cached: { client: BthClient } | null = null;

export function chain(): { client: BthClient } {
  if (cached) return cached;
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:19199";
  const idl = JSON.parse(readFileSync(resolve(ROOT, "target/idl/bethehouse.json"), "utf8"));
  const keypairPath = (process.env.DEMO_BETTOR_KEYPAIR ?? process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json").replace(/^~/, process.env.HOME ?? "~");
  const signer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, "utf8"))));
  cached = { client: new BthClient(new Connection(rpcUrl, "confirmed"), idl, signer) };
  return cached;
}

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8789";
