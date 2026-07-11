use anchor_lang::prelude::*;

#[error_code]
pub enum BthError {
    // config / params
    #[msg("fee_bps exceeds the protocol maximum")]
    FrontendFeeTooHigh,
    #[msg("invalid house parameters")]
    InvalidHouseParams,

    // house
    #[msg("house is paused")]
    HousePaused,
    #[msg("withdraw exceeds free (unlocked) collateral")]
    InsufficientFreeCollateral,

    // commit
    #[msg("outcome must be 0 (part1), 1 (draw) or 2 (part2)")]
    InvalidOutcome,
    #[msg("stake must be > 0")]
    ZeroStake,
    #[msg("fixture has already kicked off")]
    PastKickoff,
    #[msg("house cannot collateralize this bet")]
    InsufficientHouseCollateral,
    #[msg("per-fixture risk cap exceeded")]
    FixtureRiskExceeded,
    #[msg("house total risk cap exceeded")]
    TotalRiskExceeded,

    // prove / fill
    #[msg("bet is not in the required state")]
    WrongBetState,
    #[msg("oracle record does not match the bet's market (fixture/1X2/StablePrice/pre-match)")]
    RecordFilterMismatch,
    #[msg("print timestamp outside the commit staleness window")]
    OutsideCommitWindow,
    #[msg("print timestamp outside the target fill window")]
    OutsideTargetWindow,
    #[msg("oracle proof did not validate")]
    OddsProofInvalid,
    #[msg("wrong oracle root account for this timestamp")]
    WrongRootAccount,
    #[msg("odds record has no price for this outcome")]
    MissingPrice,

    // settle / void / refund
    #[msg("proof stats are not the final (game_finalised) scores")]
    NotFinalStats,
    #[msg("proof fixture does not match the bet")]
    FixtureMismatch,
    #[msg("scores stat proof did not validate")]
    StatProofInvalid,
    #[msg("commit has not expired yet")]
    NotExpired,
    #[msg("void window has not opened yet")]
    NotVoidable,

    // housekeeping
    #[msg("bet is not in a terminal state")]
    BetNotTerminal,
    #[msg("exposure still has open bets or locked collateral")]
    ExposureBusy,

    // invariants
    #[msg("vault invariant violated: vault balance < total locked")]
    VaultInvariantViolated,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
