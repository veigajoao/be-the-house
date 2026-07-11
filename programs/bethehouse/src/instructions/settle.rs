use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BthError;
use crate::instructions::{now_ms, resync_locks};
use crate::oracle::{
    self, BinaryExpression, Comparison, NDimensionalStrategy, StatPredicate, StatValidationInput,
    TraderPredicate, PERIOD_GAME_FINALISED, STAT_KEY_P1_SCORE, STAT_KEY_P2_SCORE,
};
use crate::state::{Bet, BetState, Config, FixtureExposure, House};

#[derive(Accounts)]
pub struct SettleBet<'info> {
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
        constraint = bet.state == BetState::Active @ BthError::WrongBetState,
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

    /// Winning payout destination — must belong to the bettor.
    #[account(mut, token::authority = bet.bettor, token::mint = config.usdc_mint)]
    pub bettor_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: constrained to the txoracle scores root PDA in the handler.
    pub scores_root: UncheckedAccount<'info>,

    /// CHECK: pinned to the program recorded in config.
    #[account(address = config.txoracle_program)]
    pub txoracle_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

/// Settle from the final score, proven against the txoracle scores root.
/// The stats must come from the game_finalised event (period == 100) — the
/// trustless "game finished" check. The program derives the outcome from the
/// proven values and requires txoracle to confirm the corresponding
/// predicate over the same Merkle-bound leaves.
pub fn settle_bet(ctx: Context<SettleBet>, payload: StatValidationInput) -> Result<()> {
    let config = &ctx.accounts.config;
    let bet = &mut ctx.accounts.bet;

    require!(
        payload.fixture_summary.fixture_id >= 0
            && payload.fixture_summary.fixture_id as u64 == bet.fixture_id,
        BthError::FixtureMismatch
    );
    require!(payload.stats.len() == 2, BthError::NotFinalStats);
    let s1 = &payload.stats[0].stat;
    let s2 = &payload.stats[1].stat;
    require!(
        s1.key == STAT_KEY_P1_SCORE
            && s2.key == STAT_KEY_P2_SCORE
            && s1.period == PERIOD_GAME_FINALISED
            && s2.period == PERIOD_GAME_FINALISED,
        BthError::NotFinalStats
    );

    // Outcome from the proven values; the CPI below proves the values.
    let (result_outcome, comparison) = match s1.value.cmp(&s2.value) {
        std::cmp::Ordering::Greater => (0u8, Comparison::GreaterThan),
        std::cmp::Ordering::Equal => (1u8, Comparison::EqualTo),
        std::cmp::Ordering::Less => (2u8, Comparison::LessThan),
    };
    let strategy = NDimensionalStrategy {
        geometric_targets: vec![],
        distance_predicate: None,
        discrete_predicates: vec![StatPredicate::Binary {
            index_a: 0,
            index_b: 1,
            op: BinaryExpression::Subtract,
            predicate: TraderPredicate {
                threshold: 0,
                comparison,
            },
        }],
    };

    let expected = oracle::expected_scores_root(
        &config.txoracle_program,
        payload.fixture_summary.update_stats.min_timestamp,
    )?;
    oracle::check_root_account(
        &ctx.accounts.scores_root,
        &ctx.accounts.txoracle_program,
        expected,
    )?;

    oracle::cpi_validate_stat_v2(
        ctx.accounts.txoracle_program.to_account_info(),
        ctx.accounts.scores_root.to_account_info(),
        payload,
        strategy,
    )?;

    let won = result_outcome == bet.outcome;
    if won {
        // house vault -> bettor, house PDA signs
        let house = &ctx.accounts.house;
        let seeds: &[&[u8]] = &[
            b"house",
            house.owner.as_ref(),
            &house.house_id.to_le_bytes(),
            &[house.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.house_vault.to_account_info(),
                    to: ctx.accounts.bettor_token.to_account_info(),
                    authority: ctx.accounts.house.to_account_info(),
                },
                &[seeds],
            ),
            bet.payout,
        )?;
    }

    release_and_reward(
        &ctx.accounts.config,
        bet,
        &mut ctx.accounts.house,
        &mut ctx.accounts.exposure,
        ctx.accounts.escrow_vault.to_account_info(),
        ctx.accounts.cranker_token.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    )?;
    bet.state = if won { BetState::Won } else { BetState::Lost };

    ctx.accounts.house_vault.reload()?;
    require!(
        ctx.accounts.house_vault.amount >= ctx.accounts.house.total_locked,
        BthError::VaultInvariantViolated
    );
    Ok(())
}

#[derive(Accounts)]
pub struct VoidBet<'info> {
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
        constraint = bet.state == BetState::Active @ BthError::WrongBetState,
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

    #[account(mut, token::authority = bet.bettor, token::mint = config.usdc_mint)]
    pub bettor_token: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Postponement/cancellation path: no finished-game proof N days after
/// kickoff. Returns the stake (fees already distributed at fill are not
/// clawed back — hackathon simplification).
pub fn void_bet(ctx: Context<VoidBet>) -> Result<()> {
    let bet = &mut ctx.accounts.bet;
    let now = now_ms()?;
    require!(
        now > bet
            .start_time_ms
            .checked_add(ctx.accounts.config.void_after_ms)
            .ok_or(BthError::MathOverflow)?,
        BthError::NotVoidable
    );

    // stake back: house vault -> bettor (stake was moved there at fill)
    let house = &ctx.accounts.house;
    let seeds: &[&[u8]] = &[
        b"house",
        house.owner.as_ref(),
        &house.house_id.to_le_bytes(),
        &[house.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.house_vault.to_account_info(),
                to: ctx.accounts.bettor_token.to_account_info(),
                authority: ctx.accounts.house.to_account_info(),
            },
            &[seeds],
        ),
        bet.stake,
    )?;

    release_and_reward(
        &ctx.accounts.config,
        bet,
        &mut ctx.accounts.house,
        &mut ctx.accounts.exposure,
        ctx.accounts.escrow_vault.to_account_info(),
        ctx.accounts.cranker_token.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    )?;
    bet.state = BetState::Voided;

    ctx.accounts.house_vault.reload()?;
    require!(
        ctx.accounts.house_vault.amount >= ctx.accounts.house.total_locked,
        BthError::VaultInvariantViolated
    );
    Ok(())
}

/// Shared terminal-path bookkeeping: release the filled bet's liability and
/// stake from the exposure, pay the final keeper reward from escrow.
fn release_and_reward<'info>(
    config: &Account<'info, Config>,
    bet: &mut Bet,
    house: &mut House,
    exposure: &mut FixtureExposure,
    escrow_vault: AccountInfo<'info>,
    cranker_token: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
) -> Result<()> {
    let o = bet.outcome as usize;
    exposure.liability[o] = exposure.liability[o]
        .checked_sub(bet.payout)
        .ok_or(BthError::MathOverflow)?;
    exposure.stakes_collected = exposure
        .stakes_collected
        .checked_sub(bet.stake)
        .ok_or(BthError::MathOverflow)?;
    resync_locks(house, exposure)?;
    exposure.open_bets = exposure
        .open_bets
        .checked_sub(1)
        .ok_or(BthError::MathOverflow)?;

    bet.keeper_rewards_remaining = bet
        .keeper_rewards_remaining
        .checked_sub(1)
        .ok_or(BthError::MathOverflow)?;
    let seeds: &[&[u8]] = &[b"config", &[config.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program,
            Transfer {
                from: escrow_vault,
                to: cranker_token,
                authority: config.to_account_info(),
            },
            &[seeds],
        ),
        config.keeper_reward,
    )?;
    Ok(())
}
