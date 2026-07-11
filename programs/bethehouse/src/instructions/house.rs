use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::BthError;
use crate::state::{Config, House, ODDS_SCALE};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct HouseParams {
    pub spread_bps: u16,
    pub skew_coeff_bps: u32,
    pub odds_cap: u32,
    pub max_risk_per_fixture: u64,
    pub max_total_risk: u64,
}

fn validate(p: &HouseParams) -> Result<()> {
    require!(p.odds_cap >= ODDS_SCALE as u32, BthError::InvalidHouseParams);
    require!(p.spread_bps < 10_000, BthError::InvalidHouseParams);
    require!(p.max_risk_per_fixture > 0, BthError::InvalidHouseParams);
    require!(
        p.max_total_risk >= p.max_risk_per_fixture,
        BthError::InvalidHouseParams
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(house_id: u16)]
pub struct CreateHouse<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + House::INIT_SPACE,
        seeds = [b"house", owner.key().as_ref(), &house_id.to_le_bytes()],
        bump,
    )]
    pub house: Account<'info, House>,

    #[account(
        init,
        payer = owner,
        seeds = [b"house_vault", owner.key().as_ref(), &house_id.to_le_bytes()],
        bump,
        token::mint = usdc_mint,
        token::authority = house,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn create_house(ctx: Context<CreateHouse>, house_id: u16, params: HouseParams) -> Result<()> {
    validate(&params)?;
    let house = &mut ctx.accounts.house;
    house.owner = ctx.accounts.owner.key();
    house.house_id = house_id;
    house.vault = ctx.accounts.vault.key();
    house.spread_bps = params.spread_bps;
    house.skew_coeff_bps = params.skew_coeff_bps;
    house.odds_cap = params.odds_cap;
    house.max_risk_per_fixture = params.max_risk_per_fixture;
    house.max_total_risk = params.max_total_risk;
    house.total_locked = 0;
    house.paused = false;
    house.bump = ctx.bumps.house;
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,

    pub house: Account<'info, House>,

    #[account(mut, address = house.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, token::authority = depositor)]
    pub depositor_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.depositor_token.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
    )
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"house", owner.key().as_ref(), &house.house_id.to_le_bytes()],
        bump = house.bump,
        has_one = owner,
    )]
    pub house: Account<'info, House>,

    #[account(mut, address = house.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let house = &ctx.accounts.house;
    let free = ctx
        .accounts
        .vault
        .amount
        .saturating_sub(house.total_locked);
    require!(amount <= free, BthError::InsufficientFreeCollateral);

    let owner_key = ctx.accounts.owner.key();
    let seeds: &[&[u8]] = &[
        b"house",
        owner_key.as_ref(),
        &house.house_id.to_le_bytes(),
        &[house.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.house.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    // Vault invariant: only free collateral ever leaves.
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount >= ctx.accounts.house.total_locked,
        BthError::VaultInvariantViolated
    );
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateHouse<'info> {
    pub owner: Signer<'info>,

    #[account(mut, has_one = owner)]
    pub house: Account<'info, House>,
}

/// Applies to future fills only — `reserved` on open bets is immutable.
pub fn update_house_params(ctx: Context<UpdateHouse>, params: HouseParams) -> Result<()> {
    validate(&params)?;
    let house = &mut ctx.accounts.house;
    house.spread_bps = params.spread_bps;
    house.skew_coeff_bps = params.skew_coeff_bps;
    house.odds_cap = params.odds_cap;
    house.max_risk_per_fixture = params.max_risk_per_fixture;
    house.max_total_risk = params.max_total_risk;
    Ok(())
}

pub fn set_paused(ctx: Context<UpdateHouse>, paused: bool) -> Result<()> {
    ctx.accounts.house.paused = paused;
    Ok(())
}
