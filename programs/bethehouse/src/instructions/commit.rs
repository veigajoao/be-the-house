use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BthError;
use crate::instructions::{now_ms, resync_locks};
use crate::math;
use crate::state::{Bet, BetState, Config, FixtureExposure, Frontend, House, BPS, KEEPER_CRANKS};

#[derive(Accounts)]
#[instruction(fixture_id: u64, outcome: u8, stake: u64, nonce: u64)]
pub struct CommitBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.escrow_vault)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(mut, token::authority = bettor, token::mint = config.usdc_mint)]
    pub bettor_token: Account<'info, TokenAccount>,

    pub frontend: Account<'info, Frontend>,

    #[account(mut)]
    pub house: Account<'info, House>,

    #[account(address = house.vault)]
    pub house_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + FixtureExposure::INIT_SPACE,
        seeds = [b"exposure", house.key().as_ref(), &fixture_id.to_le_bytes()],
        bump,
    )]
    pub exposure: Account<'info, FixtureExposure>,

    #[account(
        init,
        payer = bettor,
        space = 8 + Bet::INIT_SPACE,
        seeds = [b"bet", bettor.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub bet: Account<'info, Bet>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn commit_bet(
    ctx: Context<CommitBet>,
    fixture_id: u64,
    outcome: u8,
    stake: u64,
    nonce: u64,
    start_time_ms: i64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let house = &mut ctx.accounts.house;
    let exposure = &mut ctx.accounts.exposure;

    require!(!house.paused, BthError::HousePaused);
    require!(outcome <= 2, BthError::InvalidOutcome);
    require!(stake > 0, BthError::ZeroStake);

    let now = now_ms()?;
    require!(now < start_time_ms, BthError::PastKickoff);

    // Initialize exposure on first touch.
    if exposure.house == Pubkey::default() {
        exposure.house = house.key();
        exposure.fixture_id = fixture_id;
        exposure.bump = ctx.bumps.exposure;
    }

    // Reserve worst-case collateral now: fills can then never fail economically.
    let reserved = math::reserved(stake, house.odds_cap).ok_or(BthError::MathOverflow)?;
    exposure.liability[outcome as usize] = exposure.liability[outcome as usize]
        .checked_add(reserved)
        .ok_or(BthError::MathOverflow)?;
    resync_locks(house, exposure)?;

    // Three nested risk bounds + vault invariant (netting-aware: the marginal
    // lock may be < reserved on a balanced book). Races between commits resolve
    // here, atomically, in commit order.
    require!(
        exposure.locked <= house.max_risk_per_fixture,
        BthError::FixtureRiskExceeded
    );
    require!(
        house.total_locked <= house.max_total_risk,
        BthError::TotalRiskExceeded
    );
    require!(
        ctx.accounts.house_vault.amount >= house.total_locked,
        BthError::InsufficientHouseCollateral
    );

    // Fees + keeper rewards, escrowed alongside the stake.
    let frontend_fee = (stake as u128 * ctx.accounts.frontend.fee_bps as u128 / BPS as u128) as u64;
    let protocol_fee = (stake as u128 * config.protocol_fee_bps as u128 / BPS as u128) as u64;
    let keeper_total = config
        .keeper_reward
        .checked_mul(KEEPER_CRANKS)
        .ok_or(BthError::MathOverflow)?;
    let escrow_total = stake
        .checked_add(frontend_fee)
        .and_then(|v| v.checked_add(protocol_fee))
        .and_then(|v| v.checked_add(keeper_total))
        .ok_or(BthError::MathOverflow)?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bettor_token.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
                authority: ctx.accounts.bettor.to_account_info(),
            },
        ),
        escrow_total,
    )?;

    let bet = &mut ctx.accounts.bet;
    bet.bettor = ctx.accounts.bettor.key();
    bet.house = house.key();
    bet.frontend = ctx.accounts.frontend.key();
    bet.fixture_id = fixture_id;
    bet.outcome = outcome;
    bet.nonce = nonce;
    bet.stake = stake;
    bet.reserved = reserved;
    bet.commit_ts_ms = now;
    bet.target_ts_ms = now
        .checked_add(config.commit_delay_ms)
        .ok_or(BthError::MathOverflow)?;
    bet.start_time_ms = start_time_ms;
    bet.frontend_fee = frontend_fee;
    bet.protocol_fee = protocol_fee;
    bet.keeper_rewards_remaining = KEEPER_CRANKS as u8;
    bet.state = BetState::Pending;
    bet.bump = ctx.bumps.bet;

    exposure.open_bets = exposure
        .open_bets
        .checked_add(1)
        .ok_or(BthError::MathOverflow)?;

    Ok(())
}
