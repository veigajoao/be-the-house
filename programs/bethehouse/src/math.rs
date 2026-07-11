//! Pure fixed-point math for quoting, reservation and exposure netting.
//! Mirrored 1:1 by the TS reference implementation in packages/sdk/src/math.ts —
//! keep both in sync (the property tests compare them).
//!
//! Conventions: odds x1000 (u32/u64), bps /10_000, USDC 6dp (u64).
//! All intermediate arithmetic in u128, floor rounding everywhere.

use crate::state::{BPS, ODDS_SCALE};

/// Worst-case collateral reserved at commit: floor(stake * odds_cap / 1000).
pub fn reserved(stake: u64, odds_cap: u32) -> Option<u64> {
    let r = (stake as u128).checked_mul(odds_cap as u128)? / ODDS_SCALE as u128;
    u64::try_from(r).ok()
}

/// Payout at fill: floor(stake * fill_odds / 1000).
/// fill_odds <= odds_cap  =>  payout <= reserved (floor is monotone).
pub fn payout(stake: u64, fill_odds: u32) -> Option<u64> {
    let p = (stake as u128).checked_mul(fill_odds as u128)? / ODDS_SCALE as u128;
    u64::try_from(p).ok()
}

/// Netted lock for one fixture: max(liability) - stakes_collected, floored at 0.
pub fn locked(liability: &[u64; 3], stakes_collected: u64) -> u64 {
    let max = liability.iter().copied().max().unwrap_or(0);
    max.saturating_sub(stakes_collected)
}

/// Inventory-skew widening (bps) for `outcome`, given the exposure snapshot.
/// skew = skew_coeff_bps * (liability[o] - min(liability)) / max_risk_per_fixture, floor.
/// Only ever widens the heavy side; 0 on the light side; 0 if max_risk is 0.
pub fn skew_bps(
    skew_coeff_bps: u32,
    liability: &[u64; 3],
    outcome: usize,
    max_risk_per_fixture: u64,
) -> Option<u64> {
    if max_risk_per_fixture == 0 {
        return Some(0);
    }
    let min = liability.iter().copied().min().unwrap_or(0);
    let heavy = liability[outcome].saturating_sub(min);
    let s = (skew_coeff_bps as u128).checked_mul(heavy as u128)? / max_risk_per_fixture as u128;
    u64::try_from(s).ok()
}

/// House quote: fair_odds * (10000 - spread - skew) / 10000, discount capped at 100%.
pub fn eff_odds(fair_odds: u32, spread_bps: u16, skew_bps: u64) -> Option<u32> {
    let discount = (spread_bps as u128).checked_add(skew_bps as u128)?;
    let discount = discount.min(BPS as u128);
    let e = (fair_odds as u128).checked_mul(BPS as u128 - discount)? / BPS as u128;
    u32::try_from(e).ok()
}

/// Final fill odds: worse-of-two fair prints -> house quote -> odds_cap clamp.
pub fn fill_odds(
    commit_fair: u32,
    target_fair: u32,
    spread_bps: u16,
    skew_bps: u64,
    odds_cap: u32,
) -> Option<u32> {
    let fair = commit_fair.min(target_fair);
    Some(eff_odds(fair, spread_bps, skew_bps)?.min(odds_cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_and_payout_floor() {
        // 10 USDC (10_000_000) at cap 15.000x -> 150 USDC
        assert_eq!(reserved(10_000_000, 15_000), Some(150_000_000));
        // floor: 3 * 1.757 = 5.271
        assert_eq!(payout(3_000_000, 1_757), Some(5_271_000));
        // sub-unit floor: 1 lamport-of-usdc * 1.5 = 1
        assert_eq!(payout(1, 1_500), Some(1));
        assert_eq!(payout(1, 999), Some(0));
    }

    #[test]
    fn payout_never_exceeds_reserved() {
        for stake in [1u64, 7, 999_999, 10_000_000, u32::MAX as u64] {
            for cap in [1_000u32, 1_100, 5_000, 15_000] {
                for odds in [1_000u32, cap / 2 + 500, cap] {
                    let odds = odds.min(cap);
                    assert!(payout(stake, odds).unwrap() <= reserved(stake, cap).unwrap());
                }
            }
        }
    }

    #[test]
    fn locked_netting() {
        // balanced book locks ~nothing
        let liab = [100, 100, 100];
        assert_eq!(locked(&liab, 100), 0);
        // one-sided book locks max - stakes
        assert_eq!(locked(&[150, 0, 0], 10), 140);
        // stakes exceed max -> floor 0
        assert_eq!(locked(&[50, 20, 10], 60), 0);
    }

    #[test]
    fn skew_widens_heavy_side_only() {
        let liab = [90_000_000, 10_000_000, 10_000_000];
        let max_risk = 100_000_000;
        // heavy side: 5000 * 80M / 100M = 4000 bps
        assert_eq!(skew_bps(5_000, &liab, 0, max_risk), Some(4_000));
        // light sides: 0
        assert_eq!(skew_bps(5_000, &liab, 1, max_risk), Some(0));
        assert_eq!(skew_bps(5_000, &liab, 2, max_risk), Some(0));
        // zero max_risk guard
        assert_eq!(skew_bps(5_000, &liab, 0, 0), Some(0));
    }

    #[test]
    fn eff_odds_spread_and_clamp() {
        // 2.536 with 100 bps spread -> 2.510 (floor of 2536*9900/10000 = 2510.64)
        assert_eq!(eff_odds(2_536, 100, 0), Some(2_510));
        // discount saturates at 100%
        assert_eq!(eff_odds(2_536, 9_000, 5_000), Some(0));
    }

    #[test]
    fn fill_odds_worse_of_two_and_cap() {
        // adverse move: target lower -> target wins
        assert_eq!(fill_odds(2_536, 2_400, 0, 0, 15_000), Some(2_400));
        // favorable move: commit lower -> commit wins (never improves)
        assert_eq!(fill_odds(2_400, 2_536, 0, 0, 15_000), Some(2_400));
        // cap clamp
        assert_eq!(fill_odds(20_000, 19_000, 0, 0, 15_000), Some(15_000));
        // spread applies after worse-of-two
        assert_eq!(fill_odds(2_536, 2_400, 100, 0, 15_000), Some(2_376));
    }
}
