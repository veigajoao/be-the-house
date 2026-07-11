//! Trust core: CPI into the TxODDS `txoracle` program to verify odds records
//! and score stats against its published Merkle roots.
//!
//! We deliberately do NOT reimplement the Merkle hashing (undocumented);
//! txoracle's `validate_odds` / `validate_stat_v2` are permissionless,
//! read-only, and return a bool via return-data. Verified live on mainnet:
//! ~262k CU per odds validation — crank transactions need a ComputeBudget
//! bump (the SDK/keeper attach 400k).
//!
//! Timestamps are MILLISECONDS everywhere (matching the feed and txoracle).

use anchor_lang::prelude::*;

use crate::errors::BthError;

declare_program!(txoracle);

pub use txoracle::types::{
    BinaryExpression, Comparison, NDimensionalStrategy, Odds, OddsBatchSummary, ProofNode,
    ScoreStat, StatLeaf, StatPredicate, StatValidationInput, TraderPredicate,
};

/// StablePrice book identity (the only records we fill against).
pub const STABLE_PRICE_BOOKMAKER: &str = "TXLineStablePriceDemargined";
pub const STABLE_PRICE_BOOKMAKER_ID: i32 = 10021;
pub const MARKET_1X2: &str = "1X2_PARTICIPANT_RESULT";

/// `period` on a proven ScoreStat equals the event's StatusId; 100 = game_finalised.
pub const PERIOD_GAME_FINALISED: i32 = 100;
/// Stat keys for full-time scores.
pub const STAT_KEY_P1_SCORE: u32 = 1;
pub const STAT_KEY_P2_SCORE: u32 = 2;

const MS_PER_DAY: i64 = 86_400_000;

fn epoch_day(ts_ms: i64) -> Result<u16> {
    u16::try_from(ts_ms / MS_PER_DAY).map_err(|_| BthError::WrongRootAccount.into())
}

/// PDA of the daily odds batch-roots account covering `ts_ms`.
/// Layout (verified on mainnet): 8-byte discriminator + 288 x 32-byte roots,
/// slot index = hour * 12 + minute / 5.
pub fn expected_odds_root(txoracle_id: &Pubkey, ts_ms: i64) -> Result<Pubkey> {
    let day = epoch_day(ts_ms)?;
    Ok(Pubkey::find_program_address(&[b"daily_batch_roots", &day.to_le_bytes()], txoracle_id).0)
}

/// PDA of the daily scores roots account. Derived from the batch summary's
/// min timestamp (what the publisher keys the slot on).
pub fn expected_scores_root(txoracle_id: &Pubkey, min_ts_ms: i64) -> Result<Pubkey> {
    let day = epoch_day(min_ts_ms)?;
    Ok(Pubkey::find_program_address(&[b"daily_scores_roots", &day.to_le_bytes()], txoracle_id).0)
}

/// Require that `root` is the txoracle-owned PDA for this timestamp.
/// (Defense in depth: a wrong-slot root would fail the proof anyway.)
pub fn check_root_account(
    root: &AccountInfo,
    txoracle_program: &AccountInfo,
    expected: Pubkey,
) -> Result<()> {
    require_keys_eq!(*root.key, expected, BthError::WrongRootAccount);
    require_keys_eq!(*root.owner, *txoracle_program.key, BthError::WrongRootAccount);
    Ok(())
}

/// Record-level filters (bet-independent): full-time 1X2, StablePrice book,
/// not in-running. Per-bet checks (fixture match, pre-kickoff) happen at fill.
pub fn check_1x2_record(odds: &Odds) -> Result<()> {
    require!(odds.fixture_id >= 0, BthError::RecordFilterMismatch);
    require!(
        odds.super_odds_type == MARKET_1X2,
        BthError::RecordFilterMismatch
    );
    require!(
        odds.bookmaker_id == STABLE_PRICE_BOOKMAKER_ID
            && odds.bookmaker == STABLE_PRICE_BOOKMAKER,
        BthError::RecordFilterMismatch
    );
    // full-time market has no period
    require!(odds.market_period.is_none(), BthError::RecordFilterMismatch);
    require!(!odds.in_running, BthError::RecordFilterMismatch);
    require!(
        odds.prices.len() == 3 && odds.price_names.len() == 3,
        BthError::RecordFilterMismatch
    );
    Ok(())
}

/// Demargined fair odds (x1000) for `outcome` from a filtered record.
pub fn fair_odds_for_outcome(odds: &Odds, outcome: u8) -> Result<u32> {
    let price = *odds
        .prices
        .get(outcome as usize)
        .ok_or(BthError::MissingPrice)?;
    require!(price > 0, BthError::MissingPrice);
    Ok(price as u32)
}

/// CPI txoracle::validate_odds; errors unless the proof verifies to `true`.
/// The `ts` slot selector is the record's own timestamp — txoracle floors it
/// to the 5-minute slot, and a wrong slot fails the root comparison.
pub fn cpi_validate_odds<'info>(
    txoracle_program: AccountInfo<'info>,
    root: AccountInfo<'info>,
    odds: Odds,
    summary: OddsBatchSummary,
    sub_tree_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
) -> Result<()> {
    let ts = odds.ts;
    let cpi_ctx = CpiContext::new(
        txoracle_program,
        txoracle::cpi::accounts::ValidateOdds {
            daily_odds_merkle_roots: root,
        },
    );
    let ok = txoracle::cpi::validate_odds(cpi_ctx, ts, odds, summary, sub_tree_proof, main_tree_proof)?;
    require!(ok.get(), BthError::OddsProofInvalid);
    Ok(())
}

/// CPI txoracle::validate_stat_v2; errors unless the payload + strategy verify to `true`.
pub fn cpi_validate_stat_v2<'info>(
    txoracle_program: AccountInfo<'info>,
    root: AccountInfo<'info>,
    payload: StatValidationInput,
    strategy: NDimensionalStrategy,
) -> Result<()> {
    let cpi_ctx = CpiContext::new(
        txoracle_program,
        txoracle::cpi::accounts::ValidateStatV2 {
            daily_scores_merkle_roots: root,
        },
    );
    let ok = txoracle::cpi::validate_stat_v2(cpi_ctx, payload, strategy)?;
    require!(ok.get(), BthError::StatProofInvalid);
    Ok(())
}
