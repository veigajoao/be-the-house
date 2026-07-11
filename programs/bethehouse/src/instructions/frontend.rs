use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::BthError;
use crate::state::{Config, Frontend};

#[derive(Accounts)]
pub struct RegisterFrontend<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = owner,
        space = 8 + Frontend::INIT_SPACE,
        seeds = [b"frontend", owner.key().as_ref()],
        bump,
    )]
    pub frontend: Account<'info, Frontend>,

    #[account(
        init,
        payer = owner,
        seeds = [b"frontend_vault", owner.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = frontend,
    )]
    pub fee_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn register_frontend(ctx: Context<RegisterFrontend>, fee_bps: u16) -> Result<()> {
    require!(
        fee_bps <= ctx.accounts.config.max_frontend_fee_bps,
        BthError::FrontendFeeTooHigh
    );
    let frontend = &mut ctx.accounts.frontend;
    frontend.owner = ctx.accounts.owner.key();
    frontend.fee_bps = fee_bps;
    frontend.fee_vault = ctx.accounts.fee_vault.key();
    frontend.bump = ctx.bumps.frontend;
    Ok(())
}
