// Market data shared by the route handlers (was the Fastify service).
import { math } from "@bethehouse/sdk";
import {
  MARKET_1X2,
  STABLE_PRICE_BOOKMAKER_ID,
  type Fixture,
  type OddsRecord,
} from "@bethehouse/txline";
import { chain, txline } from "./server";

const COMPETITION_ID = Number(process.env.COMPETITION_ID ?? 72); // World Cup

let fixturesCache: { at: number; data: Fixture[] } | null = null;

export async function getFixtures(): Promise<Fixture[]> {
  if (!fixturesCache || Date.now() - fixturesCache.at > 60_000) {
    fixturesCache = {
      at: Date.now(),
      data: await txline().fixtures({ competitionId: COMPETITION_ID }),
    };
  }
  return fixturesCache.data;
}

export interface QuotesView {
  fixtureId: number;
  print: { ts: number; prices: number[] };
  quotes: {
    house: string;
    owner: string;
    houseId: number;
    spreadBps: number;
    oddsCap: number;
    effOdds: number[];
  }[];
  best: string[][];
}

export async function getQuotes(fixtureId: number): Promise<QuotesView | null> {
  const snapshot = await txline().oddsSnapshot(fixtureId);
  const print = snapshot.find(
    (r: OddsRecord) =>
      r.SuperOddsType === MARKET_1X2 &&
      r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
      !r.MarketPeriod &&
      !r.InRunning,
  );
  if (!print) return null;

  const { client } = chain();
  const houses = await (client.program.account as any).house.all();
  const quotes: QuotesView["quotes"] = [];
  for (const { publicKey, account } of houses) {
    if (account.paused) continue;
    let liability: [bigint, bigint, bigint] = [0n, 0n, 0n];
    try {
      const exp = await (client.program.account as any).fixtureExposure.fetch(
        client.pdas.exposure(publicKey, BigInt(fixtureId)),
      );
      liability = exp.liability.map((l: any) => BigInt(l.toString())) as typeof liability;
    } catch {
      /* no exposure yet */
    }
    const maxRisk = BigInt(account.maxRiskPerFixture.toString());
    const effOdds = [0, 1, 2].map((o) => {
      const skew = math.skewBps(account.skewCoeffBps, liability, o as 0 | 1 | 2, maxRisk);
      return Math.min(
        math.effOdds(print.Prices[o], account.spreadBps, skew),
        account.oddsCap,
      );
    });
    quotes.push({
      house: publicKey.toBase58(),
      owner: account.owner.toBase58(),
      houseId: account.houseId,
      spreadBps: account.spreadBps,
      oddsCap: account.oddsCap,
      effOdds,
    });
  }
  const best = [0, 1, 2].map((o) =>
    [...quotes].sort((a, b) => b.effOdds[o] - a.effOdds[o]).map((q) => q.house),
  );
  return { fixtureId, print: { ts: print.Ts, prices: print.Prices }, quotes, best };
}
