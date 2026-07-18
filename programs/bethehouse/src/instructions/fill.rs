use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BthError;
use crate::instructions::resync_locks;
use crate::math;
use crate::state::{Bet, BetState, Config, FixtureExposure, Frontend, House, ProvenPrint};

#[derive(Accounts)]
pub struct FillBet<'info> {
    /// Permissionless cranker; earns one keeper reward.
    pub cranker: Signer<'info>,

    #[account(mut, token::mint = config.usdc_mint)]
    pub cranker_token: Box<Account<'info, TokenAccount>>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,

    #[account(mut, address = config.escrow_vault)]
    pub escrow_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        has_one = house,
        has_one = frontend,
        constraint = bet.state == BetState::Pending @ BthError::WrongBetState,
    )]
    pub bet: Box<Account<'info, Bet>>,

    #[account(mut)]
    pub house: Box<Account<'info, House>>,

    #[account(mut, address = house.vault)]
    pub house_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"exposure", house.key().as_ref(), &bet.fixture_id.to_le_bytes()],
        bump = exposure.bump,
    )]
    pub exposure: Box<Account<'info, FixtureExposure>>,

    pub frontend: Box<Account<'info, Frontend>>,

    #[account(mut, address = frontend.fee_vault)]
    pub frontend_fee_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = config.treasury_vault)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,

    /// Merkle-verified print prevailing at commit time (see prove_print).
    #[account(constraint = commit_print.fixture_id == bet.fixture_id @ BthError::FixtureMismatch)]
    pub commit_print: Box<Account<'info, ProvenPrint>>,

    /// Merkle-verified first print at/after target (commit + 15s).
    #[account(constraint = target_print.fixture_id == bet.fixture_id @ BthError::FixtureMismatch)]
    pub target_print: Box<Account<'info, ProvenPrint>>,

    pub token_program: Program<'info, Token>,
}

/// Fill at the worse of the two proven prints, then house spread/skew,
/// clamped at odds_cap. Cannot fail economically: payout <= the collateral
/// reserved at commit. Carries no Merkle proofs — both prints were verified
/// and persisted by prove_print cranks.
fn escrow_transfer<'info>(
    token_program: &Program<'info, Token>,
    escrow_vault: &Account<'info, TokenAccount>,
    config: &Account<'info, Config>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[b"config", &[config.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: escrow_vault.to_account_info(),
                to,
                authority: config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

pub fn fill_bet(ctx: Context<FillBet>) -> Result<()> {
    let config = &ctx.accounts.config;
    let bet = &mut ctx.accounts.bet;
    let house = &mut ctx.accounts.house;
    let exposure = &mut ctx.accounts.exposure;
    let commit_print = &ctx.accounts.commit_print;
    let target_print = &ctx.accounts.target_print;

    // Fill windows (checked against Merkle-bound print timestamps).
    require!(
        commit_print.ts <= bet.commit_ts_ms
            && commit_print.ts
                >= bet
                    .commit_ts_ms
                    .checked_sub(config.staleness_window_ms)
                    .ok_or(BthError::MathOverflow)?,
        BthError::OutsideCommitWindow
    );
    // Target print: the freshest proven print the keeper found at/after the
    // commit price, capped at target + tolerance. When the feed stays silent
    // through the 15s window the keeper passes the commit print itself
    // (target == commit) and we fill at the last proven price — trusting that
    // TxODDS would have printed a new one if the market had actually moved.
    // `min(commit, target)` in fill_odds preserves the worse-of-two anti-snipe
    // whenever a genuinely fresher print does exist.
    require!(
        target_print.ts >= commit_print.ts
            && target_print.ts
                <= bet
                    .target_ts_ms
                    .checked_add(config.fill_tolerance_ms)
                    .ok_or(BthError::MathOverflow)?,
        BthError::OutsideTargetWindow
    );

    // Pre-match only: both prints must precede kickoff.
    require!(
        commit_print.ts < bet.start_time_ms && target_print.ts < bet.start_time_ms,
        BthError::PastKickoff
    );

    let o = bet.outcome as usize;
    let commit_fair = commit_print.prices[o];
    let target_fair = target_print.prices[o];
    require!(commit_fair > 0 && target_fair > 0, BthError::MissingPrice);

    // Skew from the exposure snapshot MINUS this bet's own reservation —
    // a lone bet must not widen its own quote.
    let mut liability = exposure.liability;
    liability[o] = liability[o]
        .checked_sub(bet.reserved)
        .ok_or(BthError::MathOverflow)?;
    let skew = math::skew_bps(
        house.skew_coeff_bps,
        &liability,
        o,
        house.max_risk_per_fixture,
    )
    .ok_or(BthError::MathOverflow)?;

    let fill_odds = math::fill_odds(
        commit_fair,
        target_fair,
        house.spread_bps,
        skew,
        house.odds_cap,
    )
    .ok_or(BthError::MathOverflow)?;
    let payout = math::payout(bet.stake, fill_odds).ok_or(BthError::MathOverflow)?;
    // payout <= reserved by construction (fill_odds <= odds_cap, floor-monotone)

    // Money movement: stake -> house vault; fees -> frontend/treasury;
    // keeper reward -> cranker. All from escrow, config PDA signs.
    let tp = &ctx.accounts.token_program;
    let escrow = &ctx.accounts.escrow_vault;
    escrow_transfer(tp, escrow, config, ctx.accounts.house_vault.to_account_info(), bet.stake)?;
    escrow_transfer(
        tp,
        escrow,
        config,
        ctx.accounts.frontend_fee_vault.to_account_info(),
        bet.frontend_fee,
    )?;
    escrow_transfer(
        tp,
        escrow,
        config,
        ctx.accounts.treasury_vault.to_account_info(),
        bet.protocol_fee,
    )?;
    escrow_transfer(
        tp,
        escrow,
        config,
        ctx.accounts.cranker_token.to_account_info(),
        config.keeper_reward,
    )?;

    // True the reservation down to the actual payout; netting applies.
    exposure.liability[o] = exposure.liability[o]
        .checked_sub(bet.reserved.checked_sub(payout).ok_or(BthError::MathOverflow)?)
        .ok_or(BthError::MathOverflow)?;
    exposure.stakes_collected = exposure
        .stakes_collected
        .checked_add(bet.stake)
        .ok_or(BthError::MathOverflow)?;
    resync_locks(house, exposure)?;

    bet.fill_odds = fill_odds;
    bet.fill_ts_ms = target_print.ts;
    bet.payout = payout;
    bet.keeper_rewards_remaining = bet
        .keeper_rewards_remaining
        .checked_sub(1)
        .ok_or(BthError::MathOverflow)?;
    bet.state = BetState::Active;

    // Vault invariant at the instruction boundary.
    ctx.accounts.house_vault.reload()?;
    require!(
        ctx.accounts.house_vault.amount >= house.total_locked,
        BthError::VaultInvariantViolated
    );
    Ok(())
}
