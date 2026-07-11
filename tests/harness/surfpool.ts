import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { config as dotenv } from "dotenv";

const ROOT = resolve(import.meta.dirname, "../..");
dotenv({ path: resolve(ROOT, ".env") });

export const PROGRAM_SO = resolve(ROOT, "target/deploy/bethehouse.so");
export const PROGRAM_KEYPAIR = resolve(ROOT, "target/deploy/bethehouse-keypair.json");
export const MAINNET_RPC_URL =
  process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

export function adminKeypairPath(): string {
  const raw = process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json";
  return raw.replace(/^~/, process.env.HOME ?? "~");
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

let nextPort = Number(process.env.SURFPOOL_BASE_PORT ?? 18899);

export interface Surfnet {
  rpcUrl: string;
  connection: Connection;
  process: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Spawn a surfpool surfnet forking mainnet (lazy account cloning), wait for
 * health, and deploy the bethehouse program.
 */
export async function startSurfnet(opts: { deploy?: boolean } = {}): Promise<Surfnet> {
  const port = nextPort;
  nextPort += 10; // leave room for ws port etc. between instances

  const args = [
    "start",
    "--ci",
    "--no-deploy",
    "--rpc-url", MAINNET_RPC_URL,
    "--port", String(port),
    "--ws-port", String(port + 1),
    "--studio-port", String(port + 2),
    "--airdrop-keypair-path", adminKeypairPath(),
  ];
  const proc = spawn("surfpool", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout?.on("data", (d) => (output += d.toString()));
  proc.stderr?.on("data", (d) => (output += d.toString()));

  const rpcUrl = `http://127.0.0.1:${port}`;
  const connection = new Connection(rpcUrl, "confirmed");

  // Wait for the RPC to come up.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`surfpool exited early (code ${proc.exitCode}):\n${output}`);
    }
    try {
      await connection.getLatestBlockhash();
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill("SIGKILL");
        throw new Error(`surfpool failed to become healthy:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (opts.deploy !== false) {
    if (!existsSync(PROGRAM_SO)) {
      throw new Error(`missing ${PROGRAM_SO} — run \`anchor build\` first`);
    }
    execSync(
      `solana program deploy ${PROGRAM_SO} --program-id ${PROGRAM_KEYPAIR} ` +
        `-u ${rpcUrl} -k ${adminKeypairPath()} --commitment confirmed`,
      { cwd: ROOT, stdio: "pipe" },
    );
  }

  return {
    rpcUrl,
    connection,
    process: proc,
    async stop() {
      proc.kill("SIGTERM");
      await new Promise<void>((resolveStop) => {
        const t = setTimeout(() => {
          proc.kill("SIGKILL");
          resolveStop();
        }, 5_000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolveStop();
        });
      });
    },
  };
}
