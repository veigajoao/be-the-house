// M2: prove_print replays a REAL captured mainnet proof against the REAL
// txoracle root PDA (lazily cloned from mainnet by surfpool), persisting a
// shareable ProvenPrint account. Window/fixture checks against bets happen
// at fill (M3) — this suite covers proof verification and record filters.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import {
  loadOddsProof,
  oddsRootPda,
  toOddsProofArgs,
  type OddsProofArgs,
  type RawOddsProof,
} from "./harness/fixtures.js";
import {
  fundActor,
  initProtocol,
  pda,
  TXORACLE_PROGRAM,
  type Actor,
  type Protocol,
} from "./harness/setup.js";

let surfnet: Surfnet;
let protocol: Protocol;
let cranker: Actor;

const { raw: PROOF, args: ARGS } = loadOddsProof("odds-proof-seed-18213979.json");
const FIXTURE = BigInt(PROOF.odds.FixtureId);
const PRINT_TS = PROOF.odds.Ts;

const CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

function proveIx(args: OddsProofArgs = ARGS, oddsRoot?: PublicKey) {
  return cranker.program.methods
    .provePrint(args.odds, args.summary, args.subTreeProof, args.mainTreeProof)
    .accounts({
      cranker: cranker.pubkey,
      oddsRoot: oddsRoot ?? oddsRootPda(Number(args.odds.ts)),
      txoracleProgram: TXORACLE_PROGRAM,
    })
    .preInstructions([CU]);
}

beforeAll(async () => {
  surfnet = await startSurfnet();
  protocol = await initProtocol(surfnet);
  cranker = await fundActor(surfnet, 0n);
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("prove_print (real mainnet proof replay)", () => {
  it("verifies the proof via txoracle CPI and persists the print", async () => {
    await proveIx().rpc();

    const printPda = pda.print(FIXTURE, PRINT_TS);
    const print = await cranker.program.account.provenPrint.fetch(printPda);
    expect(print.fixtureId.toNumber()).toBe(Number(FIXTURE));
    expect(print.ts.toNumber()).toBe(PRINT_TS);
    // captured record prices: [4273, 3940, 1953] (x1000 demargined odds)
    expect(print.prices).toEqual([4273, 3940, 1953]);
    expect(print.payer.toBase58()).toBe(cranker.pubkey.toBase58());
  });

  it("rejects double-proving the same print (account exists)", async () => {
    await expect(proveIx().rpc()).rejects.toThrow(/already in use|custom program error/);
  });

  it("close_print reclaims rent for the payer, and the print can be re-proven", async () => {
    const printPda = pda.print(FIXTURE, PRINT_TS);
    const before = await surfnet.connection.getBalance(cranker.pubkey);
    await cranker.program.methods
      .closePrint()
      .accounts({ payer: cranker.pubkey, print: printPda })
      .rpc();
    expect(await surfnet.connection.getAccountInfo(printPda)).toBeNull();
    expect(await surfnet.connection.getBalance(cranker.pubkey)).toBeGreaterThan(before);

    await proveIx().rpc(); // re-prove for later suites/tests
    const print = await cranker.program.account.provenPrint.fetch(printPda);
    expect(print.prices).toEqual([4273, 3940, 1953]);
  });

  // txoracle throws its own AnchorErrors on proof mismatch (rather than
  // returning false) — either way the crank tx fails; accept both shapes.
  const PROOF_FAILURE = /OddsProofInvalid|InvalidSubTreeProof|InvalidMainTreeProof/;

  it("rejects a corrupted proof (hash mismatch)", async () => {
    const corrupted = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    corrupted.subTreeProof[0].hash[0] ^= 0xff;
    corrupted.odds.ts = corrupted.odds.ts.addn(1); // fresh print PDA
    await expect(proveIx(corrupted).rpc()).rejects.toThrow(PROOF_FAILURE);
  });

  it("rejects a tampered price (leaf hash changes)", async () => {
    const tampered = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    tampered.odds.prices = [9999, 3940, 1953];
    tampered.odds.ts = tampered.odds.ts.addn(2);
    await expect(proveIx(tampered).rpc()).rejects.toThrow(PROOF_FAILURE);
  });

  it("rejects the wrong root account", async () => {
    const shifted = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    shifted.odds.ts = shifted.odds.ts.addn(3);
    const wrongRoot = oddsRootPda(PRINT_TS + 86_400_000); // next day's root
    await expect(proveIx(shifted, wrongRoot).rpc()).rejects.toThrow(/WrongRootAccount/);
  });

  it("rejects a non-1X2 record before ever touching the oracle", async () => {
    const ou = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    ou.odds.superOddsType = "OVERUNDER_PARTICIPANT_GOALS";
    ou.odds.ts = ou.odds.ts.addn(4);
    await expect(proveIx(ou).rpc()).rejects.toThrow(/RecordFilterMismatch/);
  });

  it("rejects an in-running record", async () => {
    const ir = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    ir.odds.inRunning = true;
    ir.odds.ts = ir.odds.ts.addn(5);
    await expect(proveIx(ir).rpc()).rejects.toThrow(/RecordFilterMismatch/);
  });

  it("rejects a non-full-time record (market period set)", async () => {
    const h1 = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    h1.odds.marketPeriod = "half=1";
    h1.odds.ts = h1.odds.ts.addn(6);
    await expect(proveIx(h1).rpc()).rejects.toThrow(/RecordFilterMismatch/);
  });

  it("rejects a non-StablePrice bookmaker", async () => {
    const other = toOddsProofArgs(structuredClone(PROOF) as RawOddsProof);
    other.odds.bookmakerId = 42;
    other.odds.ts = other.odds.ts.addn(7);
    await expect(proveIx(other).rpc()).rejects.toThrow(/RecordFilterMismatch/);
  });
});
