// Build UNSIGNED house-management transactions for the connected wallet
// (create / deposit / withdraw / updateParams / setPaused / setFilters).
// The wallet signs & sends client-side — the server never holds user keys.
import { NextRequest, NextResponse } from "next/server";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";

interface Params {
  spreadBps: number;
  skewCoeffBps: number;
  oddsCap: number;
  maxRiskPerFixtureUsdc: number;
  maxTotalRiskUsdc: number;
}

interface Filters {
  competitionAllow: boolean;
  competitions: number[];
  fixtureAllow: boolean;
  fixtures: (string | number)[];
}

/** The single house id the UI manages per wallet. */
const UI_HOUSE_ID = 1;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    action: "create" | "deposit" | "withdraw" | "updateParams" | "setPaused" | "setFilters";
    owner: string;
    amountUsdc?: number;
    paused?: boolean;
    params?: Params;
    filters?: Filters;
  };
  if (!body.owner) return NextResponse.json({ error: "connect a wallet" }, { status: 400 });
  const { client } = chain();
  const owner = new PublicKey(body.owner);
  const ownerToken = getAssociatedTokenAddressSync(USDC_MINT, owner);
  const house = client.pdas.house(owner, UI_HOUSE_ID);
  const vault = client.pdas.houseVault(owner, UI_HOUSE_ID);
  const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
  const toParams = (p: Params) => ({
    spreadBps: p.spreadBps,
    skewCoeffBps: p.skewCoeffBps,
    oddsCap: p.oddsCap,
    maxRiskPerFixture: usdc(p.maxRiskPerFixtureUsdc),
    maxTotalRisk: usdc(p.maxTotalRiskUsdc),
  });

  try {
    const tx = new Transaction();
    if (body.action === "create") {
      if (!body.params) throw new Error("params required");
      tx.add(
        await client.program.methods
          .createHouse(UI_HOUSE_ID, toParams(body.params))
          .accounts({ owner, usdcMint: USDC_MINT })
          .instruction(),
      );
      if (body.amountUsdc && body.amountUsdc > 0) {
        tx.add(
          await client.program.methods
            .deposit(usdc(body.amountUsdc))
            .accounts({ depositor: owner, house, vault, depositorToken: ownerToken })
            .instruction(),
        );
      }
    } else if (body.action === "deposit") {
      tx.add(
        await client.program.methods
          .deposit(usdc(body.amountUsdc!))
          .accounts({ depositor: owner, house, vault, depositorToken: ownerToken })
          .instruction(),
      );
    } else if (body.action === "withdraw") {
      tx.add(
        await client.program.methods
          .withdraw(usdc(body.amountUsdc!))
          .accounts({ owner, house, vault, destination: ownerToken })
          .instruction(),
      );
    } else if (body.action === "updateParams") {
      tx.add(
        await client.program.methods
          .updateHouseParams(toParams(body.params!))
          .accounts({ owner, house })
          .instruction(),
      );
    } else if (body.action === "setPaused") {
      tx.add(
        await client.program.methods
          .setPaused(body.paused!)
          .accounts({ owner, house })
          .instruction(),
      );
    } else if (body.action === "setFilters") {
      const f = body.filters!;
      if (f.competitions.length > 16 || f.fixtures.length > 32) {
        throw new Error("too many filter entries (max 16 competitions, 32 matches)");
      }
      tx.add(
        await client.program.methods
          .setHouseFilters(
            f.competitionAllow,
            f.competitions,
            f.fixtureAllow,
            f.fixtures.map((x) => new BN(String(x))),
          )
          .accounts({ owner, house })
          .instruction(),
      );
    } else {
      throw new Error("unknown action");
    }

    tx.feePayer = owner;
    tx.recentBlockhash = (await client.connection.getLatestBlockhash()).blockhash;

    // surface obvious failures (rent, owner mismatch, caps) before signing
    const sim = await client.connection.simulateTransaction(tx, undefined, false);
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).join(" ");
      const m = logs.match(/Error Message: ([^."]+)/);
      throw new Error(m?.[1] ?? logs.slice(-160) ?? "simulation failed");
    }

    return NextResponse.json({
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      house: house.toBase58(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 400 });
  }
}
