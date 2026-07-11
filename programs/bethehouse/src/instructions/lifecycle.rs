use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BthError;
use crate::instructions::{now_ms, resync_locks};
use crate::state::{Bet, BetState, Config, FixtureExposure, House};

#[derive(Accounts)]
pub struct RefundCommit<'info> {
    /// Anyone may crank a refund; pays the tx fee, receives nothing.
    pub cranker: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.escrow_vault)]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = house,
        constraint = bet.state == BetState::Pending @ BthError::WrongBetState,
    )]
    pub bet: Account<'info, Bet>,

    #[account(mut)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        seeds = [b"exposure", house.key().as_ref(), &bet.fixture_id.to_le_bytes()],
        bump = exposure.bump,
    )]
    pub exposure: Account<'info, FixtureExposure>,

    /// Full escrow goes back to the bettor.
    #[account(mut, token::authority = bet.bettor, token::mint = config.usdc_mint)]
    pub bettor_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// The only asynchronous failure path: no qualifying print (oracle silence)
/// or no keeper cranked. Full escrow back, reservation released.
pub fn refund_commit(ctx: Context<RefundCommit>) -> Result<()> {
    let config = &ctx.accounts.config;
    let bet = &mut ctx.accounts.bet;

    let now = now_ms()?;
    require!(
        now > bet
            .target_ts_ms
            .checked_add(config.commit_expiry_ms)
            .ok_or(BthError::MathOverflow)?,
        BthError::NotExpired
    );

    let refund = bet
        .stake
        .checked_add(bet.frontend_fee)
        .and_then(|v| v.checked_add(bet.protocol_fee))
        .and_then(|v| {
            v.checked_add(config.keeper_reward * bet.keeper_rewards_remaining as u64)
        })
        .ok_or(BthError::MathOverflow)?;

    let seeds: &[&[u8]] = &[b"config", &[config.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.bettor_token.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[seeds],
        ),
        refund,
    )?;

    // Release the reservation.
    let house = &mut ctx.accounts.house;
    let exposure = &mut ctx.accounts.exposure;
    exposure.liability[bet.outcome as usize] = exposure.liability[bet.outcome as usize]
        .checked_sub(bet.reserved)
        .ok_or(BthError::MathOverflow)?;
    resync_locks(house, exposure)?;
    exposure.open_bets = exposure
        .open_bets
        .checked_sub(1)
        .ok_or(BthError::MathOverflow)?;

    bet.state = BetState::Refunded;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBet<'info> {
    /// Rent returns to the bettor (who paid for the account at commit).
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        mut,
        close = bettor,
        has_one = bettor,
        constraint = matches!(
            bet.state,
            BetState::Won | BetState::Lost | BetState::Refunded | BetState::Voided
        ) @ BthError::BetNotTerminal,
    )]
    pub bet: Account<'info, Bet>,
}

pub fn close_bet(_ctx: Context<CloseBet>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct CloseExposure<'info> {
    /// Rent returns to the house owner.
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(has_one = owner)]
    pub house: Account<'info, House>,

    #[account(
        mut,
        close = owner,
        seeds = [b"exposure", house.key().as_ref(), &exposure.fixture_id.to_le_bytes()],
        bump = exposure.bump,
        constraint = exposure.open_bets == 0 && exposure.locked == 0 @ BthError::ExposureBusy,
    )]
    pub exposure: Account<'info, FixtureExposure>,
}

pub fn close_exposure(_ctx: Context<CloseExposure>) -> Result<()> {
    Ok(())
}
