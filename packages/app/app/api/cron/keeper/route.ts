// Keeper as a Vercel Cron: one tick per invocation (vercel.json schedules it
// every minute). Fill latency is dominated by the oracle's 5-minute root
// cadence, so 1-minute ticks cost ~30s extra latency at worst.
//
// Module-level state (Keeper instance, its ALT + known-bet cache) survives
// across invocations on a warm serverless instance; a cold start simply
// rebuilds it (and may create a fresh lookup table — pennies of rent).
import { NextRequest, NextResponse } from "next/server";
import { Keeper } from "@bethehouse/sdk";
import { chain, txline } from "../../../../lib/server";

export const maxDuration = 60; // Vercel function limit for one tick

let keeper: Keeper | null = null;
let inFlight = false;

export async function GET(req: NextRequest) {
  // Vercel sends Authorization: Bearer <CRON_SECRET> when the env var is set
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (inFlight) return NextResponse.json({ skipped: "previous tick still running" });

  inFlight = true;
  try {
    keeper ??= new Keeper(chain().client, txline(), {
      surfnetMode: process.env.SURFNET_MODE === "true",
      mainnetRpcUrl: process.env.MAINNET_RPC_URL,
    });
    const summary = await keeper.tick();
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 300) }, { status: 500 });
  } finally {
    inFlight = false;
  }
}
