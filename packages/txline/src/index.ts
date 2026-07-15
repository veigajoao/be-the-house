// Minimal TxLINE API client (mainnet production).
// Auth: guest JWT (30-day, no refresh — restart a session when near expiry)
// + long-lived API token. Both sent on every data request.

export interface TxLineConfig {
  apiBase: string; // e.g. https://txline.txodds.com
  jwt: string;
  apiToken: string;
}

export interface OddsRecord {
  FixtureId: number;
  MessageId: string;
  Ts: number; // ms
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState: string | null;
  InRunning: boolean;
  MarketParameters: string | null;
  MarketPeriod: string | null;
  PriceNames: string[];
  Prices: number[]; // x1000 demargined decimal odds
  Pct?: string[];
}

export interface Fixture {
  Ts: number;
  StartTime: number; // kickoff, ms
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
  GameState?: number;
}

export interface ProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export interface OddsValidation {
  odds: OddsRecord;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    oddsSubTreeRoot: number[];
  };
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
}

export interface ScoresEvent {
  FixtureId: number;
  Seq: number;
  Action: string;
  StatusId?: number;
  Ts: number;
  StartTime: number;
  Stats?: Record<string, number>;
}

export interface StatValidation {
  ts: number;
  statsToProve: { key: number; value: number; period: number }[];
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  statProofs: ProofNode[][];
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
}

export const STABLE_PRICE_BOOKMAKER_ID = 10021;
export const MARKET_1X2 = "1X2_PARTICIPANT_RESULT";

export class TxLineClient {
  constructor(private cfg: TxLineConfig) {}

  /** Start a fresh guest session (30-day JWT). */
  static async guestStart(apiBase: string): Promise<string> {
    const res = await fetch(`${apiBase}/auth/guest/start`, { method: "POST" });
    if (!res.ok) throw new Error(`guest/start failed: ${res.status}`);
    const { token } = (await res.json()) as { token: string };
    return token;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TxLineClient {
    // Devnet MUST be https: the host 307-redirects http->https and fetch
    // strips the Authorization header on cross-origin redirects (401s).
    const dev = env.TXLINE_ENV === "development";
    const apiBase = dev ? "https://txline-dev.txodds.com" : "https://txline.txodds.com";
    // per-environment credential sets; TXLINE_DEV_* used when TXLINE_ENV=development
    const jwt = (dev ? env.TXLINE_DEV_JWT : undefined) ?? env.TXLINE_JWT;
    const apiToken = (dev ? env.TXLINE_DEV_API_TOKEN : undefined) ?? env.TXLINE_API_TOKEN;
    if (!apiToken) throw new Error("TXLINE_API_TOKEN not set");
    if (!jwt) throw new Error("TXLINE_JWT not set (run guestStart)");
    return new TxLineClient({ apiBase, jwt, apiToken });
  }

  get apiBase(): string {
    return this.cfg.apiBase;
  }

  headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.jwt}`,
      "X-Api-Token": this.cfg.apiToken,
    };
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(`${this.cfg.apiBase}/api/${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    // hard timeout: a single hung request must not freeze a keeper loop
    const res = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new TxLineError(res.status, `${path}: ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  fixtures(params?: { startEpochDay?: number; competitionId?: number }): Promise<Fixture[]> {
    return this.get("fixtures/snapshot", params as Record<string, number>);
  }

  oddsSnapshot(fixtureId: number, asOf?: number): Promise<OddsRecord[]> {
    return this.get(`odds/snapshot/${fixtureId}`, asOf ? { asOf } : undefined);
  }

  /** ~6 days of update history for one fixture. */
  oddsUpdates(fixtureId: number): Promise<OddsRecord[]> {
    return this.get(`odds/updates/${fixtureId}`);
  }

  /** 404s until the record's 5-min batch root is published (~35s past boundary). */
  oddsValidation(messageId: string, ts: number): Promise<OddsValidation> {
    return this.get("odds/validation", { messageId, ts });
  }

  scoresSnapshot(fixtureId: number, asOf?: number): Promise<ScoresEvent[]> {
    return this.get(`scores/snapshot/${fixtureId}`, asOf ? { asOf } : undefined);
  }

  statValidation(fixtureId: number, seq: number, statKeys: number[]): Promise<StatValidation> {
    return this.get("scores/stat-validation", {
      fixtureId,
      seq,
      statKeys: statKeys.join(","),
    });
  }
}

export class TxLineError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
