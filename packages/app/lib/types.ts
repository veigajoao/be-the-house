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
  bettor: string;
  bettorUsdc: number;
  programId: string;
}

export const OUTCOME_LABEL = ["Home", "Draw", "Away"];
export const OUTCOME_SYM = ["1", "X", "2"];
export const fmtOdds = (x1000: number) => (x1000 / 1000).toFixed(3);
export const fmtUsdc = (micro: number) =>
  (micro / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
