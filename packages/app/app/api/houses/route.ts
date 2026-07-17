// Houses with the three-way vault split the dashboard needs:
//   free     = vault - total_locked           (withdrawable now)
//   reserved = Σ reserved of Pending bets     (pending commits, gross at cap)
//   locked   = total_locked - overlap         (filled bets, netted)
// total_locked already nets pending gross reservations into the book, so we
// present: reserved = min(Σ pending reserved, total_locked), locked = rest.
import { NextRequest, NextResponse } from "next/server";
import { chain } from "../../../lib/server";
import { getHouseFilters } from "../../../lib/market";

export async function GET(req: NextRequest) {
  const ownerFilter = req.nextUrl.searchParams.get("owner");
  const { client } = chain();
  const [housesAll, bets, exposures] = await Promise.all([
    (client.program.account as any).house.all(),
    (client.program.account as any).bet.all(),
    (client.program.account as any).fixtureExposure.all(),
  ]);
  const houses = ownerFilter
    ? housesAll.filter((h: any) => h.account.owner.toBase58() === ownerFilter)
    : housesAll;

  const out = [];
  for (const { publicKey, account } of houses) {
    let vault = 0;
    try {
      vault = Number(
        (await client.connection.getTokenAccountBalance(account.vault)).value.amount,
      );
    } catch {
      /* empty vault account */
    }
    const totalLocked = account.totalLocked.toNumber();
    const pendingReserved = bets
      .filter(
        (b: any) => b.account.house.equals(publicKey) && b.account.state.pending,
      )
      .reduce((s: number, b: any) => s + b.account.reserved.toNumber(), 0);
    const reserved = Math.min(pendingReserved, totalLocked);
    const lockedNet = totalLocked - reserved;

    const exps = exposures
      .filter((e: any) => e.account.house.equals(publicKey))
      .map((e: any) => ({
        fixtureId: e.account.fixtureId.toString(),
        liability: e.account.liability.map((l: any) => l.toNumber()),
        stakesCollected: e.account.stakesCollected.toNumber(),
        locked: e.account.locked.toNumber(),
        openBets: e.account.openBets,
      }));

    out.push({
      pda: publicKey.toBase58(),
      owner: account.owner.toBase58(),
      houseId: account.houseId,
      spreadBps: account.spreadBps,
      skewCoeffBps: account.skewCoeffBps,
      oddsCap: account.oddsCap,
      maxRiskPerFixture: account.maxRiskPerFixture.toNumber(),
      maxTotalRisk: account.maxTotalRisk.toNumber(),
      paused: account.paused,
      vault,
      free: vault - totalLocked,
      reserved,
      locked: lockedNet,
      totalLocked,
      exposures: exps,
      filters: await getHouseFilters(publicKey),
    });
  }
  return NextResponse.json(out);
}
