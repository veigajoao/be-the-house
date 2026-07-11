import { NextRequest, NextResponse } from "next/server";
import { chain } from "../../../lib/server";

export async function GET(req: NextRequest) {
  const fixtureId = req.nextUrl.searchParams.get("fixtureId");
  const { client } = chain();
  const bets = await (client.program.account as any).bet.all();
  const view = bets
    .filter(
      (b: any) => !fixtureId || b.account.fixtureId.toString() === fixtureId,
    )
    .map((b: any) => ({
      pda: b.publicKey.toBase58(),
      outcome: b.account.outcome,
      stake: b.account.stake.toNumber(),
      state: Object.keys(b.account.state)[0],
      fillOdds: b.account.fillOdds,
      payout: b.account.payout.toNumber(),
    }));
  return NextResponse.json(view);
}
