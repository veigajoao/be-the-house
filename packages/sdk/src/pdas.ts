import { PublicKey } from "@solana/web3.js";

// Overridable for a devnet deployment (devnet txoracle:
// 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J, plus a devnet test mint).
const env = typeof process !== "undefined" ? process.env : undefined;
export const TXORACLE_PROGRAM = new PublicKey(
  env?.TXORACLE_PROGRAM ?? "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
);
export const USDC_MINT = new PublicKey(
  env?.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

const MS_PER_DAY = 86_400_000;

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
const i64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

export function makePdas(programId: PublicKey) {
  const find = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    config: () => find([Buffer.from("config")]),
    treasury: () => find([Buffer.from("treasury")]),
    escrow: () => find([Buffer.from("escrow")]),
    frontend: (owner: PublicKey) => find([Buffer.from("frontend"), owner.toBuffer()]),
    frontendVault: (owner: PublicKey) =>
      find([Buffer.from("frontend_vault"), owner.toBuffer()]),
    house: (owner: PublicKey, houseId: number) =>
      find([Buffer.from("house"), owner.toBuffer(), u16le(houseId)]),
    houseVault: (owner: PublicKey, houseId: number) =>
      find([Buffer.from("house_vault"), owner.toBuffer(), u16le(houseId)]),
    exposure: (house: PublicKey, fixtureId: bigint | number) =>
      find([Buffer.from("exposure"), house.toBuffer(), u64le(fixtureId)]),
    bet: (bettor: PublicKey, nonce: bigint | number) =>
      find([Buffer.from("bet"), bettor.toBuffer(), u64le(nonce)]),
    print: (fixtureId: bigint | number, tsMs: bigint | number) =>
      find([Buffer.from("print"), u64le(fixtureId), i64le(tsMs)]),
  };
}

/** txoracle daily odds batch-roots PDA covering `tsMs`. */
export function oddsRootPda(tsMs: number, txoracle: PublicKey = TXORACLE_PROGRAM): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_batch_roots"), u16le(Math.floor(tsMs / MS_PER_DAY))],
    txoracle,
  )[0];
}

/** txoracle daily scores roots PDA covering `minTsMs`. */
export function scoresRootPda(minTsMs: number, txoracle: PublicKey = TXORACLE_PROGRAM): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), u16le(Math.floor(minTsMs / MS_PER_DAY))],
    txoracle,
  )[0];
}
