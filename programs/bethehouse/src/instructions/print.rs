use anchor_lang::prelude::*;

use crate::oracle::{self, Odds, OddsBatchSummary, ProofNode};
use crate::state::{Config, ProvenPrint};

#[derive(Accounts)]
#[instruction(odds: Odds)]
pub struct ProvePrint<'info> {
    /// Permissionless cranker; pays the print account rent (reclaimable via
    /// close_print once the print is no longer needed).
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = cranker,
        space = 8 + ProvenPrint::INIT_SPACE,
        // i64 LE bytes == u64 LE bytes for the same bit pattern, so these
        // match the u64 fixture_id derivation used by clients.
        seeds = [
            b"print",
            odds.fixture_id.to_le_bytes().as_ref(),
            odds.ts.to_le_bytes().as_ref(),
        ],
        bump,
    )]
    pub print: Account<'info, ProvenPrint>,

    /// CHECK: constrained to the txoracle root PDA for the record's timestamp
    /// in the handler (owner + derived key).
    pub odds_root: UncheckedAccount<'info>,

    /// CHECK: pinned to the program recorded in config.
    #[account(address = config.txoracle_program)]
    pub txoracle_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Merkle-verify a full-time 1X2 StablePrice print via txoracle CPI and
/// persist it as a small ProvenPrint account. Proofs are ~770 bytes so a
/// fill (which needs TWO prints) can never carry them inline — instead,
/// prints are proven once, shared by every bet on the fixture, and
/// `fill_bet` just reads the two accounts.
pub fn prove_print(
    ctx: Context<ProvePrint>,
    odds: Odds,
    summary: OddsBatchSummary,
    sub_tree_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
) -> Result<()> {
    let config = &ctx.accounts.config;

    // Record-level filters (bet-independent): full-time 1X2, StablePrice,
    // pre-match record shape. Kickoff comparison happens per-bet at fill.
    oracle::check_1x2_record(&odds)?;

    // Root account must be the txoracle PDA covering this print.
    let expected = oracle::expected_odds_root(&config.txoracle_program, odds.ts)?;
    oracle::check_root_account(
        &ctx.accounts.odds_root,
        &ctx.accounts.txoracle_program,
        expected,
    )?;

    let fixture_id = odds.fixture_id as u64;
    let ts = odds.ts;
    let mut prices = [0u32; 3];
    for (i, p) in prices.iter_mut().enumerate() {
        *p = oracle::fair_odds_for_outcome(&odds, i as u8)?;
    }

    // Merkle verification (CPI; errors or returns false on any mismatch).
    oracle::cpi_validate_odds(
        ctx.accounts.txoracle_program.to_account_info(),
        ctx.accounts.odds_root.to_account_info(),
        odds,
        summary,
        sub_tree_proof,
        main_tree_proof,
    )?;

    let print = &mut ctx.accounts.print;
    print.fixture_id = fixture_id;
    print.ts = ts;
    print.prices = prices;
    print.payer = ctx.accounts.cranker.key();
    print.bump = ctx.bumps.print;
    Ok(())
}

#[derive(Accounts)]
pub struct ClosePrint<'info> {
    /// Only the rent payer may reclaim it.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, close = payer, has_one = payer)]
    pub print: Account<'info, ProvenPrint>,
}

/// Reclaim print rent. If a still-pending bet needed this print, any keeper
/// can simply re-prove it — proofs remain fetchable from the oracle API.
pub fn close_print(_ctx: Context<ClosePrint>) -> Result<()> {
    Ok(())
}
