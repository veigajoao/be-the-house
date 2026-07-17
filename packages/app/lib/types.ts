export interface FixtureRow {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number;
  Competition: string;
}

export interface Quotes {
  fixtureId: number;
  print: { ts: number; prices: number[] };
  quotes: {
    house: string;
    houseId: number;
    spreadBps: number;
    oddsCap: number;
    effOdds: number[];
  }[];
  best: string[][];
}

export interface BetView {
  pda: string;
  house: string;
  fixtureId: string;
  fixture: string;
  outcome: number;
  stake: number;
  state: "pending" | "active" | "won" | "lost" | "refunded" | "voided";
  commitTsMs: number;
  targetTsMs: number;
  startTimeMs: number;
  fillOdds: number;
  fillTsMs: number;
  payout: number;
  frontendFee: number;
  protocolFee: number;
  settleTx: string | null;
}

export interface HouseView {
  pda: string;
  owner: string;
  houseId: number;
  spreadBps: number;
  skewCoeffBps: number;
  oddsCap: number;
  maxRiskPerFixture: number;
  maxTotalRisk: number;
  paused: boolean;
  vault: number;
  free: number;
  reserved: number;
  locked: number;
  totalLocked: number;
  exposures: {
    fixtureId: string;
    liability: number[];
    stakesCollected: number;
    locked: number;
    openBets: number;
  }[];
}

export interface AppConfig {
  protocolFeeBps: number;
  frontendFeeBps: number;
  keeperReward: number;
  programId: string;
  // timing windows (ms) — deployment-specific (tight mainnet spec vs widened devnet)
  commitDelayMs: number;
  stalenessWindowMs: number;
  fillToleranceMs: number;
  commitExpiryMs: number;
  voidAfterMs: number;
}

export const OUTCOME_LABEL = ["Home", "Draw", "Away"];
export const OUTCOME_SYM = ["1", "X", "2"];
export const fmtOdds = (x1000: number) => (x1000 / 1000).toFixed(3);
export const fmtUsdc = (micro: number) =>
  (micro / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Human duration from ms: 15000→"15s", 2700000→"45min", 3600000→"1h", 7200000→"2h". */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}
