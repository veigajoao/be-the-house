import { NextRequest, NextResponse } from "next/server";
import { scoresRootPda } from "@bethehouse/sdk";
import { API_URL, chain } from "../../../lib/server";

interface Fixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number;
}

export async function GET(req: NextRequest) {
  const fixtureFilter = req.nextUrl.searchParams.get("fixtureId");
  const { client } = chain();
  const bets = await (client.program.account as any).bet.all();

  let fixtures: Fixture[] = [];
  try {
    fixtures = (await fetch(`${API_URL}/fixtures`).then((r) => r.json())) as Fixture[];
  } catch {
    /* API down — names degrade to ids */
  }
  const nameOf = (id: string) => {
    const f = fixtures.find((f) => String(f.FixtureId) === id);
    return f ? `${f.Participant1} — ${f.Participant2}` : `Fixture #${id}`;
  };

  const view = [];
  for (const b of bets) {
    const a = b.account;
    const fixtureId = a.fixtureId.toString();
    if (fixtureFilter && fixtureId !== fixtureFilter) continue;
    const state = Object.keys(a.state)[0] as string;

    // receipt data for terminal states: settle tx + scores root
    let settleTx: string | null = null;
    let scoresRoot: string | null = null;
    if (state === "won" || state === "lost") {
      try {
        const sigs = await client.connection.getSignaturesForAddress(b.publicKey, { limit: 1 });
        settleTx = sigs[0]?.signature ?? null;
      } catch {
        /* ok */
      }
    }

    view.push({
      pda: b.publicKey.toBase58(),
      house: a.house.toBase58(),
      fixtureId,
      fixture: nameOf(fixtureId),
      outcome: a.outcome,
      stake: a.stake.toNumber(),
      state,
      commitTsMs: a.commitTsMs.toNumber(),
      targetTsMs: a.targetTsMs.toNumber(),
      startTimeMs: a.startTimeMs.toNumber(),
      fillOdds: a.fillOdds,
      fillTsMs: a.fillTsMs.toNumber(),
      payout: a.payout.toNumber(),
      reserved: a.reserved.toNumber(),
      frontendFee: a.frontendFee.toNumber(),
      protocolFee: a.protocolFee.toNumber(),
      settleTx,
      scoresRoot,
    });
  }
  view.sort((a, b) => b.commitTsMs - a.commitTsMs);
  return NextResponse.json(view);
}
