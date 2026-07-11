// TxLINE API JSON (PascalCase records / camelCase proofs) -> Anchor argument
// objects for bethehouse instructions.
import * as anchorNs from "@coral-xyz/anchor";
// CJS/ESM interop: under plain node/tsx the CJS re-exports (BN, web3, ...)
// live on the namespace's `default`; under vitest they're flattened.
const anchor: typeof anchorNs = ((anchorNs as unknown as { default?: typeof anchorNs }).default ?? anchorNs) as typeof anchorNs;
const { BN } = anchor;
import type { OddsValidation, StatValidation } from "@bethehouse/txline";

export function oddsProofToArgs(v: OddsValidation) {
  return {
    odds: {
      fixtureId: new BN(v.odds.FixtureId),
      messageId: v.odds.MessageId,
      ts: new BN(v.odds.Ts),
      bookmaker: v.odds.Bookmaker,
      bookmakerId: v.odds.BookmakerId,
      superOddsType: v.odds.SuperOddsType,
      gameState: v.odds.GameState,
      inRunning: v.odds.InRunning,
      marketParameters: v.odds.MarketParameters,
      marketPeriod: v.odds.MarketPeriod,
      priceNames: v.odds.PriceNames,
      prices: v.odds.Prices,
    },
    summary: {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      oddsSubTreeRoot: v.summary.oddsSubTreeRoot,
    },
    subTreeProof: v.subTreeProof,
    mainTreeProof: v.mainTreeProof,
  };
}

export function statProofToPayload(v: StatValidation) {
  return {
    // txoracle requires payload.ts == summary.updateStats.minTimestamp
    // (slot-seed check; differs from the event ts on multi-update batches)
    ts: new BN(v.summary.updateStats.minTimestamp),
    fixtureSummary: {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
    },
    fixtureProof: v.subTreeProof,
    mainTreeProof: v.mainTreeProof,
    eventStatRoot: v.eventStatRoot,
    stats: v.statsToProve.map((s, i) => ({
      stat: { key: s.key, value: s.value, period: s.period },
      statProof: v.statProofs[i],
    })),
  };
}
