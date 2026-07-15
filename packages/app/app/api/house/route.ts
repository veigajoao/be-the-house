// House management, signed by the demo keypair (owner = demo signer).
// Actions: create | deposit | withdraw | setPaused | updateParams
import { NextRequest, NextResponse } from "next/server";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT } from "@bethehouse/sdk";
import { chain } from "../../../lib/server";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    action: "create" | "deposit" | "withdraw" | "setPaused" | "updateParams";
    houseId?: number;
    house?: string;
    amountUsdc?: number;
    paused?: boolean;
    params?: {
      spreadBps: number;
      skewCoeffBps: number;
      oddsCap: number;
      maxRiskPerFixtureUsdc: number;
      maxTotalRiskUsdc: number;
    };
  };
  const { client } = chain();
  const owner = client.signer.publicKey;
  const ownerToken = getAssociatedTokenAddressSync(USDC_MINT, owner);
  const usdc = (n: number) => new BN(Math.round(n * 1_000_000));

  const toParams = (p: NonNullable<typeof body.params>) => ({
    spreadBps: p.spreadBps,
    skewCoeffBps: p.skewCoeffBps,
    oddsCap: p.oddsCap,
    maxRiskPerFixture: usdc(p.maxRiskPerFixtureUsdc),
    maxTotalRisk: usdc(p.maxTotalRiskUsdc),
  });

  try {
    if (body.action === "create") {
      if (!body.params || body.houseId === undefined) throw new Error("params + houseId required");
      await client.program.methods
        .createHouse(body.houseId, toParams(body.params))
        .accounts({ owner, usdcMint: USDC_MINT })
        .rpc();
      const house = client.pdas.house(owner, body.houseId);
      if (body.amountUsdc) {
        const acc = await (client.program.account as any).house.fetch(house);
        await client.program.methods
          .deposit(usdc(body.amountUsdc))
          .accounts({ depositor: owner, house, vault: acc.vault, depositorToken: ownerToken })
          .rpc();
      }
      return NextResponse.json({ house: house.toBase58() });
    }

    const house = new PublicKey(body.house!);
    const acc = await (client.program.account as any).house.fetch(house);
    if (body.action === "deposit") {
      await client.program.methods
        .deposit(usdc(body.amountUsdc!))
        .accounts({ depositor: owner, house, vault: acc.vault, depositorToken: ownerToken })
        .rpc();
    } else if (body.action === "withdraw") {
      await client.program.methods
        .withdraw(usdc(body.amountUsdc!))
        .accounts({ owner, house, vault: acc.vault, destination: ownerToken })
        .rpc();
    } else if (body.action === "setPaused") {
      await client.program.methods.setPaused(body.paused!).accounts({ owner, house }).rpc();
    } else if (body.action === "updateParams") {
      await client.program.methods
        .updateHouseParams(toParams(body.params!))
        .accounts({ owner, house })
        .rpc();
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 400 });
  }
}
