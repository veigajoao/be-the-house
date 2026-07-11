use anchor_lang::prelude::*;

/// Global protocol configuration. Seeds: ["config"].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    /// Token account (authority = config PDA) receiving protocol fees.
    pub treasury_vault: Pubkey,
    /// Token account (authority = config PDA) holding bettor escrow between commit and fill/refund.
    pub escrow_vault: Pubkey,
    /// The txoracle program our fills/settlements CPI into.
    pub txoracle_program: Pubkey,
    pub protocol_fee_bps: u16,
    pub max_frontend_fee_bps: u16,
    /// Flat USDC reward paid per successful crank (prove / fill / settle / void).
    pub keeper_reward: u64,
    /// target_ts = commit_ts + commit_delay_ms (spec: 15_000).
    pub commit_delay_ms: i64,
    /// Commit print must satisfy: commit_ts - staleness_window_ms <= odds.ts <= commit_ts.
    pub staleness_window_ms: i64,
    /// Target print must satisfy: target_ts <= odds.ts <= target_ts + fill_tolerance_ms.
    pub fill_tolerance_ms: i64,
    /// refund_commit allowed once now > target_ts + commit_expiry_ms.
    pub commit_expiry_ms: i64,
    /// void_bet allowed once now > start_time + void_after_ms.
    pub void_after_ms: i64,
    pub bump: u8,
}

/// Registered frontend integrator. Seeds: ["frontend", owner].
#[account]
#[derive(InitSpace)]
pub struct Frontend {
    pub owner: Pubkey,
    pub fee_bps: u16,
    /// Token account (authority = frontend PDA) receiving frontend fees.
    pub fee_vault: Pubkey,
    pub bump: u8,
}

/// An individual LP "house". Seeds: ["house", owner, house_id le].
#[account]
#[derive(InitSpace)]
pub struct House {
    pub owner: Pubkey,
    pub house_id: u16,
    /// Token account (authority = house PDA) holding the house's collateral.
    pub vault: Pubkey,
    pub spread_bps: u16,
    pub skew_coeff_bps: u32,
    /// Max odds this house pays, x1000. Bounds the collateral reserved per commit.
    pub odds_cap: u32,
    /// Caps `locked` on any single fixture.
    pub max_risk_per_fixture: u64,
    /// Caps `total_locked` across all fixtures.
    pub max_total_risk: u64,
    /// Sum of `locked` across fixtures. Vault invariant: vault.amount >= total_locked.
    pub total_locked: u64,
    pub paused: bool,
    pub bump: u8,
}

/// Per (house, fixture) exposure book. Seeds: ["exposure", house, fixture_id le].
/// Lazily created at first commit.
#[account]
#[derive(InitSpace)]
pub struct FixtureExposure {
    pub house: Pubkey,
    pub fixture_id: u64,
    /// Potential payout per outcome (0 = part1, 1 = draw, 2 = part2).
    /// Pending commits count gross `reserved`; trued down to actual payout at fill.
    pub liability: [u64; 3],
    /// Stakes collected from filled bets on this fixture (moved into the house vault).
    pub stakes_collected: u64,
    /// max(liability) - stakes_collected, floored at 0. Portion of the vault reserved here.
    pub locked: u64,
    /// Open (non-terminal) bets referencing this exposure; gates close_exposure.
    pub open_bets: u32,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BetState {
    /// Committed; commit print not yet proven.
    Pending,
    /// Commit print proven (commit_fair_odds set); awaiting target print + fill.
    CommitProven,
    /// Filled; awaiting settlement.
    Active,
    Won,
    Lost,
    Refunded,
    Voided,
}

/// A bet through its whole lifecycle (single fixed-size account, no realloc).
/// Seeds: ["bet", bettor, nonce le].
#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub bettor: Pubkey,
    pub house: Pubkey,
    pub frontend: Pubkey,
    pub fixture_id: u64,
    pub outcome: u8,
    pub nonce: u64,
    pub stake: u64,
    /// floor(stake * odds_cap / 1000), reserved on the exposure at commit.
    pub reserved: u64,
    pub commit_ts_ms: i64,
    pub target_ts_ms: i64,
    /// Fixture kickoff (ms). Hackathon: supplied by the SDK at commit (spec note A).
    pub start_time_ms: i64,
    pub frontend_fee: u64,
    pub protocol_fee: u64,
    /// Keeper rewards still escrowed (starts at 3: prove + fill + settle/void).
    pub keeper_rewards_remaining: u8,
    /// Fair odds (x1000) from the proven commit-window print.
    pub commit_fair_odds: u32,
    pub commit_print_ts_ms: i64,
    /// Final odds (x1000) after worse-of-two, spread/skew, odds_cap clamp.
    pub fill_odds: u32,
    pub fill_ts_ms: i64,
    /// floor(stake * fill_odds / 1000).
    pub payout: u64,
    pub state: BetState,
    pub bump: u8,
}

pub const ODDS_SCALE: u64 = 1000;
pub const BPS: u64 = 10_000;
/// prove + fill + settle-or-void.
pub const KEEPER_CRANKS: u64 = 3;
