// M1 gate for the replay strategy. Verified on surfpool 1.3.1:
//   - backward surfnet_timeTravel is NOT supported ("Cannot travel to past timestamp")
//   - so historical-proof replay patches Bet-account timestamps via surfnet_setAccount
//     (hex data) instead of warping the clock
//   - forward timeTravel (ms) works and is used for expiry/void tests
//   - surfnet_setTokenAccount funds USDC balances against the cloned mainnet mint
// This file asserts exactly those three capabilities.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import { timeTravel, setTokenAccount, patchAccountData } from "./harness/cheats.js";
import { USDC_MINT } from "./harness/setup.js";

let surfnet: Surfnet;

beforeAll(async () => {
  surfnet = await startSurfnet({ deploy: false });
});

afterAll(async () => {
  await surfnet?.stop();
});

const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

async function clockNowSec(): Promise<number> {
  const info = await surfnet.connection.getAccountInfo(CLOCK);
  if (!info) throw new Error("no clock sysvar");
  return Number(info.data.readBigInt64LE(32)); // unix_timestamp at offset 32
}

describe("surfpool cheatcode capabilities (replay strategy gate)", () => {
  it("funds USDC balances via setTokenAccount (cloned mainnet mint)", async () => {
    const who = Keypair.generate();
    await setTokenAccount(surfnet.connection, who.publicKey, USDC_MINT, 123_000_000n);
    const ata = getAssociatedTokenAddressSync(USDC_MINT, who.publicKey);
    const bal = await surfnet.connection.getTokenAccountBalance(ata);
    expect(bal.value.amount).toBe("123000000");
  });

  it("patches raw account data via setAccount (hex)", async () => {
    const who = Keypair.generate();
    await setTokenAccount(surfnet.connection, who.publicKey, USDC_MINT, 5n);
    const ata = getAssociatedTokenAddressSync(USDC_MINT, who.publicKey);
    // token account amount lives at offset 64
    await patchAccountData(surfnet.connection, ata, (data) => {
      data.writeBigUInt64LE(999n, 64);
    });
    const bal = await surfnet.connection.getTokenAccountBalance(ata);
    expect(bal.value.amount).toBe("999");
  });

  it("travels forward in time (ms)", async () => {
    const before = await clockNowSec();
    await timeTravel(surfnet.connection, (before + 7_200) * 1000);
    const after = await clockNowSec();
    expect(after).toBeGreaterThan(before + 7_000);
  });
});
