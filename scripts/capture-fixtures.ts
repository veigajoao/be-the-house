// Capture deterministic oracle fixtures for the surfpool replay tests:
//   - odds print PAIRS (commit print + target print, 45-135s apart) with
//     Merkle validation proofs, for fill_bet's worse-of-two
//   - final-score stat proofs (game_finalised, statKeys 1,2) for settle_bet
//
// Usage:
//   pnpm capture odds <fixtureId>          # capture a print pair
//   pnpm capture scores <fixtureId>        # capture the final-score proof
//   pnpm capture find-finished [epochDay]  # list finished fixtures + results
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import {
  MARKET_1X2,
  STABLE_PRICE_BOOKMAKER_ID,
  TxLineClient,
  type OddsRecord,
} from "../packages/txline/src/index.js";

const ROOT = resolve(import.meta.dirname, "..");
dotenv({ path: resolve(ROOT, ".env") });
const FIXTURES_DIR = resolve(ROOT, "fixtures");

const client = TxLineClient.fromEnv();

function is1x2FullTimeStable(r: OddsRecord): boolean {
  return (
    r.SuperOddsType === MARKET_1X2 &&
    r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
    !r.MarketPeriod &&
    !r.InRunning &&
    r.Prices.length === 3
  );
}

async function captureOddsPair(fixtureId: number): Promise<void> {
  const updates = (await client.oddsUpdates(fixtureId)).filter(is1x2FullTimeStable);
  updates.sort((a, b) => a.Ts - b.Ts);
  console.log(`${updates.length} stable 1X2 FT prints for fixture ${fixtureId}`);
  if (updates.length < 2) throw new Error("not enough prints");

  // Windows: commit = ts1 + 30s (print1 inside the 120s staleness window);
  // target = commit + 15s; print2 must be in [target, target+90s]
  // => 45s <= ts2 - ts1 <= 135s. Prefer pairs where prices MOVED (so the
  // worse-of-two test is meaningful in both directions).
  type Pair = { a: OddsRecord; b: OddsRecord; gap: number; moved: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < updates.length - 1; i++) {
    for (let j = i + 1; j < updates.length; j++) {
      const gap = updates[j].Ts - updates[i].Ts;
      if (gap > 135_000) break;
      if (gap < 45_000) continue;
      const moved = updates[i].Prices.reduce(
        (acc, p, k) => acc + Math.abs(p - updates[j].Prices[k]),
        0,
      );
      pairs.push({ a: updates[i], b: updates[j], gap, moved });
    }
  }
  if (!pairs.length) throw new Error("no print pair with 45-135s gap");
  pairs.sort((x, y) => y.moved - x.moved);
  const pick = pairs[0];
  console.log(
    `picked pair gap=${(pick.gap / 1000).toFixed(1)}s moved=${pick.moved} ` +
      `prices ${JSON.stringify(pick.a.Prices)} -> ${JSON.stringify(pick.b.Prices)}`,
  );

  const [proofA, proofB] = await Promise.all([
    client.oddsValidation(pick.a.MessageId, pick.a.Ts),
    client.oddsValidation(pick.b.MessageId, pick.b.Ts),
  ]);

  // adverse/favorable direction per outcome (from the bettor's viewpoint):
  // target price lower than commit price = adverse move (fill degrades)
  const direction = pick.a.Prices.map((p, k) =>
    pick.b.Prices[k] < p ? "adverse" : pick.b.Prices[k] > p ? "favorable" : "flat",
  );

  const fixtures = await client.fixtures();
  const meta = fixtures.find((f) => f.FixtureId === fixtureId);

  const out = {
    fixtureId,
    fixture: meta ?? null,
    recommendedCommitTsMs: pick.a.Ts + 30_000,
    commitPrint: proofA,
    targetPrint: proofB,
    gapMs: pick.gap,
    direction,
  };
  const file = resolve(FIXTURES_DIR, `odds-pair-${fixtureId}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`wrote ${file}`);
}

async function captureScores(fixtureId: number): Promise<void> {
  const events = await client.scoresSnapshot(fixtureId);
  const finalised = events.find((e) => e.Action === "game_finalised");
  if (!finalised) throw new Error(`no game_finalised event for ${fixtureId}`);
  const s1 = finalised.Stats?.["1"] ?? 0;
  const s2 = finalised.Stats?.["2"] ?? 0;
  console.log(`fixture ${fixtureId} finalised seq=${finalised.Seq} score ${s1}-${s2}`);

  const proof = await client.statValidation(fixtureId, finalised.Seq, [1, 2]);
  const out = { fixtureId, seq: finalised.Seq, score: [s1, s2], proof };
  const file = resolve(FIXTURES_DIR, `stat-${fixtureId}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`wrote ${file}`);
}

async function findFinished(startEpochDay?: number): Promise<void> {
  const fixtures = await client.fixtures(startEpochDay ? { startEpochDay } : undefined);
  const now = Date.now();
  const done = fixtures.filter((f) => f.StartTime < now - 3 * 3600 * 1000);
  for (const f of done) {
    try {
      const events = await client.scoresSnapshot(f.FixtureId);
      const fin = events.find((e) => e.Action === "game_finalised");
      if (!fin) continue;
      const s1 = fin.Stats?.["1"] ?? 0;
      const s2 = fin.Stats?.["2"] ?? 0;
      const kind = s1 > s2 ? "HOME" : s1 < s2 ? "AWAY" : "DRAW";
      console.log(
        `${f.FixtureId} ${f.Participant1} v ${f.Participant2} ${s1}-${s2} ${kind} seq=${fin.Seq}`,
      );
    } catch {
      /* no scores coverage */
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "odds" && arg) await captureOddsPair(Number(arg));
else if (cmd === "scores" && arg) await captureScores(Number(arg));
else if (cmd === "find-finished") await findFinished(arg ? Number(arg) : undefined);
else {
  console.log("usage: capture-fixtures.ts odds <fixtureId> | scores <fixtureId> | find-finished [epochDay]");
  process.exit(1);
}
