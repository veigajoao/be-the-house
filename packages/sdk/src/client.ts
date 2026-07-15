// Program client shared by the keeper, demo script and example frontend.
import * as anchorNs from "@coral-xyz/anchor";
// CJS/ESM interop: under plain node/tsx the CJS re-exports (BN, web3, ...)
// live on the namespace's `default`; under vitest they're flattened.
const anchor: typeof anchorNs = ((anchorNs as unknown as { default?: typeof anchorNs }).default ?? anchorNs) as typeof anchorNs;
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { OddsValidation, StatValidation } from "@bethehouse/txline";
import { makePdas, oddsRootPda, scoresRootPda, TXORACLE_PROGRAM } from "./pdas.js";
import { oddsProofToArgs, statProofToPayload } from "./mappers.js";

export const CU_LIMIT = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

export interface BetAccount {
  bettor: PublicKey;
  house: PublicKey;
  frontend: PublicKey;
  fixtureId: anchorNs.BN;
  outcome: number;
  nonce: anchorNs.BN;
  stake: anchorNs.BN;
  reserved: anchorNs.BN;
  commitTsMs: anchorNs.BN;
  targetTsMs: anchorNs.BN;
  startTimeMs: anchorNs.BN;
  state: Record<string, unknown>;
  payout: anchorNs.BN;
  fillOdds: number;
}

export class BthClient {
  readonly program: anchorNs.Program;
  readonly pdas: ReturnType<typeof makePdas>;
  readonly connection: Connection;

  constructor(
    connection: Connection,
    idl: anchorNs.Idl,
    readonly signer: Keypair,
  ) {
    // anchor's Wallet is Node-only (missing from the ESM/browser build that
    // webpack picks) — a minimal wallet object is all AnchorProvider needs.
    const wallet = {
      publicKey: signer.publicKey,
      payer: signer,
      signTransaction: async <T,>(tx: T): Promise<T> => {
        if (tx instanceof VersionedTransaction) tx.sign([signer]);
        else (tx as { partialSign(k: Keypair): void }).partialSign(signer);
        return tx;
      },
      signAllTransactions: async <T,>(txs: T[]): Promise<T[]> => {
        for (const tx of txs) {
          if (tx instanceof VersionedTransaction) tx.sign([signer]);
          else (tx as { partialSign(k: Keypair): void }).partialSign(signer);
        }
        return txs;
      },
    };
    const provider = new anchor.AnchorProvider(connection, wallet as anchorNs.Wallet, {
      commitment: "confirmed",
    });
    this.program = new anchor.Program(idl, provider);
    this.pdas = makePdas(this.program.programId);
    this.connection = connection;
  }

  // --- lookup table (prove_print proofs only fit v0 txs with an ALT) ---

  async createProveLut(rootAddresses: PublicKey[]): Promise<AddressLookupTableAccount> {
    const slot = await this.connection.getSlot("finalized");
    const [createIx, table] = AddressLookupTableProgram.createLookupTable({
      authority: this.signer.publicKey,
      payer: this.signer.publicKey,
      recentSlot: slot,
    });
    const addresses = [
      this.program.programId,
      TXORACLE_PROGRAM,
      ComputeBudgetProgram.programId,
      SystemProgram.programId,
      this.pdas.config(),
      ...rootAddresses,
    ];
    const ixs: TransactionInstruction[] = [createIx];
    for (let i = 0; i < addresses.length; i += 20) {
      ixs.push(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: table,
          authority: this.signer.publicKey,
          payer: this.signer.publicKey,
          addresses: addresses.slice(i, i + 20),
        }),
      );
    }
    await this.sendV0(ixs);
    await new Promise((r) => setTimeout(r, 1_000)); // table warm-up slot
    const acc = await this.connection.getAddressLookupTable(table);
    if (!acc.value) throw new Error("lookup table missing after creation");
    return acc.value;
  }

  async extendLut(lut: AddressLookupTableAccount, addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
    const fresh = addresses.filter(
      (a) => !lut.state.addresses.some((x) => x.equals(a)),
    );
    if (fresh.length) {
      await this.sendV0([
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: lut.key,
          authority: this.signer.publicKey,
          payer: this.signer.publicKey,
          addresses: fresh,
        }),
      ]);
      await new Promise((r) => setTimeout(r, 1_000));
      const acc = await this.connection.getAddressLookupTable(lut.key);
      if (acc.value) return acc.value;
    }
    return lut;
  }

  async sendV0(
    ixs: TransactionInstruction[],
    lut?: AddressLookupTableAccount,
  ): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(lut ? [lut] : []);
    const tx = new VersionedTransaction(msg);
    tx.sign([this.signer]);
    const sig = await this.connection.sendTransaction(tx);
    await this.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  // --- cranks ---

  async provePrint(proof: OddsValidation, lut: AddressLookupTableAccount): Promise<string | null> {
    const printPda = this.pdas.print(proof.odds.FixtureId, proof.odds.Ts);
    if (await this.connection.getAccountInfo(printPda)) return null; // already proven
    const args = oddsProofToArgs(proof);
    const ix = await this.program.methods
      .provePrint(args.odds, args.summary, args.subTreeProof, args.mainTreeProof)
      .accounts({
        cranker: this.signer.publicKey,
        oddsRoot: oddsRootPda(proof.odds.Ts),
        txoracleProgram: TXORACLE_PROGRAM,
      })
      .instruction();
    return this.sendV0([CU_LIMIT, ix], lut);
  }

  async fillBet(
    betPda: PublicKey,
    bet: BetAccount,
    house: { vault: PublicKey },
    frontend: { feeVault: PublicKey },
    crankerToken: PublicKey,
    commitPrintTs: number,
    targetPrintTs: number,
  ): Promise<string> {
    const fixtureId = BigInt(bet.fixtureId.toString());
    return this.program.methods
      .fillBet()
      .accounts({
        cranker: this.signer.publicKey,
        crankerToken,
        escrowVault: this.pdas.escrow(),
        bet: betPda,
        house: bet.house,
        houseVault: house.vault,
        exposure: this.pdas.exposure(bet.house, fixtureId),
        frontend: bet.frontend,
        frontendFeeVault: frontend.feeVault,
        treasuryVault: this.pdas.treasury(),
        commitPrint: this.pdas.print(fixtureId, commitPrintTs),
        targetPrint: this.pdas.print(fixtureId, targetPrintTs),
      })
      .rpc();
  }

  async settleBet(
    betPda: PublicKey,
    bet: BetAccount,
    house: { vault: PublicKey },
    bettorToken: PublicKey,
    crankerToken: PublicKey,
    proof: StatValidation,
  ): Promise<string> {
    const payload = statProofToPayload(proof);
    return this.program.methods
      .settleBet(payload)
      .accounts({
        cranker: this.signer.publicKey,
        crankerToken,
        escrowVault: this.pdas.escrow(),
        bet: betPda,
        house: bet.house,
        houseVault: house.vault,
        exposure: this.pdas.exposure(bet.house, BigInt(bet.fixtureId.toString())),
        bettorToken,
        scoresRoot: scoresRootPda(proof.summary.updateStats.minTimestamp),
        txoracleProgram: TXORACLE_PROGRAM,
      })
      .preInstructions([CU_LIMIT])
      .rpc();
  }

  async refundCommit(
    betPda: PublicKey,
    bet: BetAccount,
    bettorToken: PublicKey,
  ): Promise<string> {
    return this.program.methods
      .refundCommit()
      .accounts({
        cranker: this.signer.publicKey,
        escrowVault: this.pdas.escrow(),
        bet: betPda,
        house: bet.house,
        exposure: this.pdas.exposure(bet.house, BigInt(bet.fixtureId.toString())),
        bettorToken,
      })
      .rpc();
  }
}
