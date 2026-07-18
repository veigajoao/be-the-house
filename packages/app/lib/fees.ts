// Fee-inclusive staking math (shared by the bet API and the bet slip UI).
//
// The on-chain commit pulls `stake + frontend_fee + protocol_fee + keeper` from
// the bettor in one shot (programs/bethehouse/src/instructions/commit.rs), where
// each percentage fee is floored independently and the keeper reward is a flat
// amount. The program is agnostic to where `stake` comes from, so to make the
// slip's headline equal the amount actually charged (fees inclusive, not added
// on top) we invert: given what the bettor wants to spend, solve for the largest
// on-chain stake whose full debit lands at or just under that amount.
//
// All amounts here are integer µUSDC (1 USDC = 1e6), matching the program.

// programs/bethehouse/src/state.rs — prove + fill cranks, each paid keeper_reward.
export const KEEPER_CRANKS = 2;

export type FeeModel = {
  frontendFeeBps: number;
  protocolFeeBps: number;
  keeperUusdc: number; // keeper_reward × KEEPER_CRANKS, escrowed at commit
};

/** Build the fee model from the app config (keeperReward is µUSDC per crank). */
export function feeModel(c: {
  frontendFeeBps: number;
  protocolFeeBps: number;
  keeperReward: number;
}): FeeModel {
  return {
    frontendFeeBps: c.frontendFeeBps,
    protocolFeeBps: c.protocolFeeBps,
    keeperUusdc: c.keeperReward * KEEPER_CRANKS,
  };
}

const floorFee = (stake: number, bps: number) => Math.floor((stake * bps) / 10_000);

/** The fee/keeper breakdown the program adds for a given on-chain stake (µUSDC). */
export function feesOnStake(stakeUusdc: number, m: FeeModel) {
  const frontend = floorFee(stakeUusdc, m.frontendFeeBps);
  const protocol = floorFee(stakeUusdc, m.protocolFeeBps);
  return { frontend, protocol, keeper: m.keeperUusdc, total: frontend + protocol + m.keeperUusdc };
}

/** Total the wallet is debited at commit for a given on-chain stake (µUSDC). */
export function chargeForStake(stakeUusdc: number, m: FeeModel): number {
  return stakeUusdc + feesOnStake(stakeUusdc, m).total;
}

/**
 * Largest on-chain stake whose full debit (stake + fees + keeper) is ≤ the
 * amount the bettor wants to spend. Rounds down so we never charge more than the
 * headline; returns 0 when the spend can't even cover the flat keeper reward.
 */
export function stakeForCharge(chargeUusdc: number, m: FeeModel): number {
  const bps = m.frontendFeeBps + m.protocolFeeBps;
  let s = Math.floor(((chargeUusdc - m.keeperUusdc) * 10_000) / (10_000 + bps));
  if (s <= 0) return 0;
  // correct for per-fee flooring (never more than a µUSDC or two off the estimate)
  while (chargeForStake(s + 1, m) <= chargeUusdc) s++;
  while (s > 0 && chargeForStake(s, m) > chargeUusdc) s--;
  return s;
}
