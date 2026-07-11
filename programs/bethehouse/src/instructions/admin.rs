use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::Config;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ConfigParams {
    pub protocol_fee_bps: u16,
    pub max_frontend_fee_bps: u16,
    pub keeper_reward: u64,
    pub commit_delay_ms: i64,
    pub staleness_window_ms: i64,
    pub fill_tolerance_ms: i64,
    pub commit_expiry_ms: i64,
    pub void_after_ms: i64,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub usdc_mint: Account<'info, Mint>,

    /// CHECK: the txoracle program this deployment validates proofs against.
    pub txoracle_program: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [b"treasury"],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub treasury_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        seeds = [b"escrow"],
        bump,
        token::mint = usdc_mint,
        token::authority = config,
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.treasury_vault = ctx.accounts.treasury_vault.key();
    config.escrow_vault = ctx.accounts.escrow_vault.key();
    config.txoracle_program = ctx.accounts.txoracle_program.key();
    config.bump = ctx.bumps.config;
    apply(config, params);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
    apply(&mut ctx.accounts.config, params);
    Ok(())
}

fn apply(config: &mut Config, p: ConfigParams) {
    config.protocol_fee_bps = p.protocol_fee_bps;
    config.max_frontend_fee_bps = p.max_frontend_fee_bps;
    config.keeper_reward = p.keeper_reward;
    config.commit_delay_ms = p.commit_delay_ms;
    config.staleness_window_ms = p.staleness_window_ms;
    config.fill_tolerance_ms = p.fill_tolerance_ms;
    config.commit_expiry_ms = p.commit_expiry_ms;
    config.void_after_ms = p.void_after_ms;
}
