import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { adminKeypairPath, loadKeypair, type Surfnet } from "./surfpool.js";
import { setTokenAccount } from "./cheats.js";

const ROOT = resolve(import.meta.dirname, "../..");

export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
export const TXORACLE_PROGRAM = new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA");

export const IDL = JSON.parse(
  readFileSync(resolve(ROOT, "target/idl/bethehouse.json"), "utf8"),
);
export const PROGRAM_ID = new PublicKey(IDL.address);

export const DEFAULT_CONFIG = {
  protocolFeeBps: 100,
  maxFrontendFeeBps: 500,
  keeperReward: new anchor.BN(1_000_000), // 1 USDC per crank
  commitDelayMs: new anchor.BN(15_000),
  stalenessWindowMs: new anchor.BN(120_000),
  fillToleranceMs: new anchor.BN(90_000),
  commitExpiryMs: new anchor.BN(3_600_000),
  voidAfterMs: new anchor.BN(3 * 86_400_000),
};

// --- PDAs ---
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

export const pda = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0],
  treasury: () => PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID)[0],
  escrow: () => PublicKey.findProgramAddressSync([Buffer.from("escrow")], PROGRAM_ID)[0],
  frontend: (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("frontend"), owner.toBuffer()], PROGRAM_ID)[0],
  frontendVault: (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("frontend_vault"), owner.toBuffer()],
      PROGRAM_ID,
    )[0],
  house: (owner: PublicKey, houseId: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("house"), owner.toBuffer(), u16le(houseId)],
      PROGRAM_ID,
    )[0],
  houseVault: (owner: PublicKey, houseId: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("house_vault"), owner.toBuffer(), u16le(houseId)],
      PROGRAM_ID,
    )[0],
  exposure: (house: PublicKey, fixtureId: bigint | number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("exposure"), house.toBuffer(), u64le(fixtureId)],
      PROGRAM_ID,
    )[0],
  bet: (bettor: PublicKey, nonce: bigint | number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), bettor.toBuffer(), u64le(nonce)],
      PROGRAM_ID,
    )[0],
  print: (fixtureId: bigint | number, tsMs: bigint | number) => {
    const ts = Buffer.alloc(8);
    ts.writeBigInt64LE(BigInt(tsMs));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("print"), u64le(fixtureId), ts],
      PROGRAM_ID,
    )[0];
  },
};

export function programFor(surfnet: Surfnet, signer: Keypair): anchor.Program {
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(surfnet.connection, wallet, {
    commitment: "confirmed",
  });
  return new anchor.Program(IDL, provider);
}

export interface Protocol {
  admin: Keypair;
  program: anchor.Program; // admin-signed
  config: PublicKey;
  treasury: PublicKey;
  escrow: PublicKey;
}

/** Initialize protocol config on a fresh surfnet. */
export async function initProtocol(
  surfnet: Surfnet,
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
): Promise<Protocol> {
  const admin = loadKeypair(adminKeypairPath());
  const program = programFor(surfnet, admin);
  await program.methods
    .initConfig({ ...DEFAULT_CONFIG, ...overrides })
    .accounts({
      admin: admin.publicKey,
      usdcMint: USDC_MINT,
      txoracleProgram: TXORACLE_PROGRAM,
    })
    .rpc();
  return {
    admin,
    program,
    config: pda.config(),
    treasury: pda.treasury(),
    escrow: pda.escrow(),
  };
}

export interface Actor {
  keypair: Keypair;
  pubkey: PublicKey;
  usdc: PublicKey; // associated token account
  program: anchor.Program; // signed as this actor
}

/** Create a keypair funded with SOL + USDC (via cheatcodes). */
export async function fundActor(
  surfnet: Surfnet,
  usdcAmount: bigint | number = 1_000_000_000n, // 1000 USDC
): Promise<Actor> {
  const keypair = Keypair.generate();
  const admin = loadKeypair(adminKeypairPath());

  // SOL from the pre-airdropped admin (surfpool airdrops the admin at startup).
  const adminProgram = programFor(surfnet, admin);
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: keypair.publicKey,
      lamports: 10 * LAMPORTS_PER_SOL,
    }),
  );
  await adminProgram.provider.sendAndConfirm!(tx, [admin]);

  await setTokenAccount(surfnet.connection, keypair.publicKey, USDC_MINT, usdcAmount);
  const usdc = getAssociatedTokenAddressSync(USDC_MINT, keypair.publicKey);
  return { keypair, pubkey: keypair.publicKey, usdc, program: programFor(surfnet, keypair) };
}

export async function usdcBalance(surfnet: Surfnet, tokenAccount: PublicKey): Promise<bigint> {
  const bal = await surfnet.connection.getTokenAccountBalance(tokenAccount);
  return BigInt(bal.value.amount);
}

/**
 * Create + extend an address lookup table. Oracle proofs are ~770 bytes, so
 * prove_print txs only fit the 1232-byte limit when the static accounts
 * (programs, config, daily root PDAs) are referenced through an ALT.
 */
export async function createLookupTable(
  surfnet: Surfnet,
  payer: Keypair,
  addresses: PublicKey[],
): Promise<AddressLookupTableAccount> {
  const conn = surfnet.connection;
  const slot = await conn.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  const ixs: TransactionInstruction[] = [createIx];
  for (let i = 0; i < addresses.length; i += 20) {
    ixs.push(
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: table,
        authority: payer.publicKey,
        payer: payer.publicKey,
        addresses: addresses.slice(i, i + 20),
      }),
    );
  }
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  // table must be one slot old before use
  await new Promise((r) => setTimeout(r, 1_000));
  const acc = await conn.getAddressLookupTable(table);
  if (!acc.value) throw new Error("lookup table not found after creation");
  return acc.value;
}

/** Send instructions as a v0 transaction referencing a lookup table. */
export async function sendV0(
  surfnet: Surfnet,
  payer: Keypair,
  ixs: TransactionInstruction[],
  lut: AddressLookupTableAccount,
): Promise<string> {
  const conn = surfnet.connection;
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([lut]);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

/**
 * Time-shift a Bet account so its windows line up with a historical oracle
 * print (surfpool cannot travel backward; see clock.smoke.test.ts). Decodes
 * with the Anchor coder, patches fields, re-encodes, writes via setAccount.
 */
export async function patchBet(
  surfnet: Surfnet,
  program: anchor.Program,
  bet: PublicKey,
  patch: Partial<{ commitTsMs: number; targetTsMs: number; startTimeMs: number }>,
): Promise<void> {
  const info = await surfnet.connection.getAccountInfo(bet);
  if (!info) throw new Error("bet account not found");
  const decoded = program.coder.accounts.decode("bet", info.data);
  if (patch.commitTsMs !== undefined) decoded.commitTsMs = new anchor.BN(patch.commitTsMs);
  if (patch.targetTsMs !== undefined) decoded.targetTsMs = new anchor.BN(patch.targetTsMs);
  if (patch.startTimeMs !== undefined) decoded.startTimeMs = new anchor.BN(patch.startTimeMs);
  const encoded = await program.coder.accounts.encode("bet", decoded);
  const data = Buffer.alloc(info.data.length);
  encoded.copy(data);
  const { setAccount } = await import("./cheats.js");
  await setAccount(surfnet.connection, bet, { data: data.toString("hex") });
}
