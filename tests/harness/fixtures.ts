import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { TXORACLE_PROGRAM } from "./setup.js";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");

export interface RawOddsProof {
  odds: {
    FixtureId: number;
    MessageId: string;
    Ts: number;
    Bookmaker: string;
    BookmakerId: number;
    SuperOddsType: string;
    GameState: string | null;
    InRunning: boolean;
    MarketParameters: string | null;
    MarketPeriod: string | null;
    PriceNames: string[];
    Prices: number[];
  };
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    oddsSubTreeRoot: number[];
  };
  subTreeProof: { hash: number[]; isRightSibling: boolean }[];
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[];
}

/** Anchor-arg shapes for bethehouse::prove_commit_print / fill_bet. */
export interface OddsProofArgs {
  odds: {
    fixtureId: anchor.BN;
    messageId: string;
    ts: anchor.BN;
    bookmaker: string;
    bookmakerId: number;
    superOddsType: string;
    gameState: string | null;
    inRunning: boolean;
    marketParameters: string | null;
    marketPeriod: string | null;
    priceNames: string[];
    prices: number[];
  };
  summary: {
    fixtureId: anchor.BN;
    updateStats: {
      updateCount: number;
      minTimestamp: anchor.BN;
      maxTimestamp: anchor.BN;
    };
    oddsSubTreeRoot: number[];
  };
  subTreeProof: { hash: number[]; isRightSibling: boolean }[];
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[];
}

export function toOddsProofArgs(raw: RawOddsProof): OddsProofArgs {
  return {
    odds: {
      fixtureId: new anchor.BN(raw.odds.FixtureId),
      messageId: raw.odds.MessageId,
      ts: new anchor.BN(raw.odds.Ts),
      bookmaker: raw.odds.Bookmaker,
      bookmakerId: raw.odds.BookmakerId,
      superOddsType: raw.odds.SuperOddsType,
      gameState: raw.odds.GameState,
      inRunning: raw.odds.InRunning,
      marketParameters: raw.odds.MarketParameters,
      marketPeriod: raw.odds.MarketPeriod,
      priceNames: raw.odds.PriceNames,
      prices: raw.odds.Prices,
    },
    summary: {
      fixtureId: new anchor.BN(raw.summary.fixtureId),
      updateStats: {
        updateCount: raw.summary.updateStats.updateCount,
        minTimestamp: new anchor.BN(raw.summary.updateStats.minTimestamp),
        maxTimestamp: new anchor.BN(raw.summary.updateStats.maxTimestamp),
      },
      oddsSubTreeRoot: raw.summary.oddsSubTreeRoot,
    },
    subTreeProof: raw.subTreeProof.map((n) => ({ hash: n.hash, isRightSibling: n.isRightSibling })),
    mainTreeProof: raw.mainTreeProof.map((n) => ({
      hash: n.hash,
      isRightSibling: n.isRightSibling,
    })),
  };
}

export function loadOddsProof(file: string): { raw: RawOddsProof; args: OddsProofArgs } {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES, file), "utf8")) as RawOddsProof;
  return { raw, args: toOddsProofArgs(raw) };
}

const MS_PER_DAY = 86_400_000;

/** txoracle daily odds batch-roots PDA covering `tsMs`. */
export function oddsRootPda(tsMs: number): PublicKey {
  const day = Buffer.alloc(2);
  day.writeUInt16LE(Math.floor(tsMs / MS_PER_DAY));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_batch_roots"), day],
    TXORACLE_PROGRAM,
  )[0];
}

/** txoracle daily scores roots PDA covering `minTsMs`. */
export function scoresRootPda(minTsMs: number): PublicKey {
  const day = Buffer.alloc(2);
  day.writeUInt16LE(Math.floor(minTsMs / MS_PER_DAY));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), day],
    TXORACLE_PROGRAM,
  )[0];
}
