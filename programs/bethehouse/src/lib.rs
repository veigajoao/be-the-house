use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod state;

use instructions::*;

declare_id!("Au4V34qyUhMfAL9HfC3QLTtTi6Mua7WdqDYUdZqhEdGS");

#[program]
pub mod bethehouse {
    use super::*;

    // --- admin ---
    pub fn init_config(ctx: Context<InitConfig>, params: ConfigParams) -> Result<()> {
        instructions::init_config(ctx, params)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, params: ConfigParams) -> Result<()> {
        instructions::update_config(ctx, params)
    }

    // --- frontend ---
    pub fn register_frontend(ctx: Context<RegisterFrontend>, fee_bps: u16) -> Result<()> {
        instructions::register_frontend(ctx, fee_bps)
    }

    // --- house ---
    pub fn create_house(
        ctx: Context<CreateHouse>,
        house_id: u16,
        params: HouseParams,
    ) -> Result<()> {
        instructions::create_house(ctx, house_id, params)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw(ctx, amount)
    }

    pub fn update_house_params(ctx: Context<UpdateHouse>, params: HouseParams) -> Result<()> {
        instructions::update_house_params(ctx, params)
    }

    pub fn set_paused(ctx: Context<UpdateHouse>, paused: bool) -> Result<()> {
        instructions::set_paused(ctx, paused)
    }

    pub fn set_house_filters(
        ctx: Context<SetHouseFilters>,
        competition_allow: bool,
        competitions: Vec<u32>,
        fixture_allow: bool,
        fixtures: Vec<u64>,
    ) -> Result<()> {
        instructions::set_house_filters(ctx, competition_allow, competitions, fixture_allow, fixtures)
    }

    // --- bets ---
    pub fn commit_bet(
        ctx: Context<CommitBet>,
        fixture_id: u64,
        outcome: u8,
        stake: u64,
        nonce: u64,
        start_time_ms: i64,
    ) -> Result<()> {
        instructions::commit_bet(ctx, fixture_id, outcome, stake, nonce, start_time_ms)
    }

    pub fn prove_print(
        ctx: Context<ProvePrint>,
        odds: crate::oracle::Odds,
        summary: crate::oracle::OddsBatchSummary,
        sub_tree_proof: Vec<crate::oracle::ProofNode>,
        main_tree_proof: Vec<crate::oracle::ProofNode>,
    ) -> Result<()> {
        instructions::prove_print(ctx, odds, summary, sub_tree_proof, main_tree_proof)
    }

    pub fn close_print(ctx: Context<ClosePrint>) -> Result<()> {
        instructions::close_print(ctx)
    }

    pub fn fill_bet(ctx: Context<FillBet>) -> Result<()> {
        instructions::fill_bet(ctx)
    }

    pub fn settle_bet(
        ctx: Context<SettleBet>,
        payload: crate::oracle::StatValidationInput,
    ) -> Result<()> {
        instructions::settle_bet(ctx, payload)
    }

    pub fn void_bet(ctx: Context<VoidBet>) -> Result<()> {
        instructions::void_bet(ctx)
    }

    pub fn refund_commit(ctx: Context<RefundCommit>) -> Result<()> {
        instructions::refund_commit(ctx)
    }

    // --- housekeeping ---
    pub fn close_bet(ctx: Context<CloseBet>) -> Result<()> {
        instructions::close_bet(ctx)
    }

    pub fn close_exposure(ctx: Context<CloseExposure>) -> Result<()> {
        instructions::close_exposure(ctx)
    }
}
