import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as anchor from "@coral-xyz/anchor";
import { startSurfnet, type Surfnet } from "./harness/surfpool.js";
import {
  fundActor,
  initProtocol,
  pda,
  usdcBalance,
  USDC_MINT,
  type Actor,
  type Protocol,
} from "./harness/setup.js";

let surfnet: Surfnet;
let protocol: Protocol;
let owner: Actor;

const HOUSE_ID = 1;
const PARAMS = {
  spreadBps: 100,
  skewCoeffBps: 5_000,
  oddsCap: 15_000,
  maxRiskPerFixture: new anchor.BN(500_000_000), // 500 USDC
  maxTotalRisk: new anchor.BN(800_000_000),
};

beforeAll(async () => {
  surfnet = await startSurfnet();
  protocol = await initProtocol(surfnet);
  owner = await fundActor(surfnet, 1_000_000_000n); // 1000 USDC
});

afterAll(async () => {
  await surfnet?.stop();
});

describe("house lifecycle", () => {
  const house = () => pda.house(owner.pubkey, HOUSE_ID);
  const vault = () => pda.houseVault(owner.pubkey, HOUSE_ID);

  it("rejects invalid params at create", async () => {
    await expect(
      owner.program.methods
        .createHouse(2, { ...PARAMS, oddsCap: 999 })
        .accounts({ owner: owner.pubkey, usdcMint: USDC_MINT })
        .rpc(),
    ).rejects.toThrow(/InvalidHouseParams/);
  });

  it("creates a house", async () => {
    await owner.program.methods
      .createHouse(HOUSE_ID, PARAMS)
      .accounts({ owner: owner.pubkey, usdcMint: USDC_MINT })
      .rpc();
    const acc = await owner.program.account.house.fetch(house());
    expect(acc.owner.toBase58()).toBe(owner.pubkey.toBase58());
    expect(acc.oddsCap).toBe(15_000);
    expect(acc.totalLocked.toNumber()).toBe(0);
    expect(acc.paused).toBe(false);
  });

  it("deposits collateral", async () => {
    await owner.program.methods
      .deposit(new anchor.BN(600_000_000))
      .accounts({
        depositor: owner.pubkey,
        house: house(),
        vault: vault(),
        depositorToken: owner.usdc,
      })
      .rpc();
    expect(await usdcBalance(surfnet, vault())).toBe(600_000_000n);
  });

  it("withdraws free collateral", async () => {
    await owner.program.methods
      .withdraw(new anchor.BN(100_000_000))
      .accounts({
        owner: owner.pubkey,
        house: house(),
        vault: vault(),
        destination: owner.usdc,
      })
      .rpc();
    expect(await usdcBalance(surfnet, vault())).toBe(500_000_000n);
  });

  it("rejects withdrawing more than the vault balance", async () => {
    await expect(
      owner.program.methods
        .withdraw(new anchor.BN(500_000_001))
        .accounts({
          owner: owner.pubkey,
          house: house(),
          vault: vault(),
          destination: owner.usdc,
        })
        .rpc(),
    ).rejects.toThrow(/InsufficientFreeCollateral/);
  });

  it("rejects withdraw by non-owner", async () => {
    const mallory = await fundActor(surfnet, 0n);
    await expect(
      mallory.program.methods
        .withdraw(new anchor.BN(1))
        .accounts({
          owner: mallory.pubkey,
          house: house(),
          vault: vault(),
          destination: owner.usdc,
        })
        .rpc(),
    ).rejects.toThrow(); // seeds/has_one mismatch
  });

  it("updates params and pause flag", async () => {
    await owner.program.methods
      .updateHouseParams({ ...PARAMS, spreadBps: 250 })
      .accounts({ owner: owner.pubkey, house: house() })
      .rpc();
    let acc = await owner.program.account.house.fetch(house());
    expect(acc.spreadBps).toBe(250);

    await owner.program.methods
      .setPaused(true)
      .accounts({ owner: owner.pubkey, house: house() })
      .rpc();
    acc = await owner.program.account.house.fetch(house());
    expect(acc.paused).toBe(true);

    await owner.program.methods
      .setPaused(false)
      .accounts({ owner: owner.pubkey, house: house() })
      .rpc();
  });
});
