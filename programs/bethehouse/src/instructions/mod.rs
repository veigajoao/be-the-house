pub mod admin;
pub mod commit;
pub mod frontend;
pub mod house;
pub mod lifecycle;
pub mod print;

pub use admin::*;
pub use commit::*;
pub use frontend::*;
pub use house::*;
pub use lifecycle::*;
pub use print::*;

use anchor_lang::prelude::*;

use crate::errors::BthError;
use crate::math;
use crate::state::{FixtureExposure, House};

/// Recompute `exposure.locked` from its liabilities/stakes and roll the delta
/// into `house.total_locked`. Call after any liability/stakes mutation.
pub fn resync_locks(house: &mut House, exposure: &mut FixtureExposure) -> Result<()> {
    let new_locked = math::locked(&exposure.liability, exposure.stakes_collected);
    let delta = new_locked as i128 - exposure.locked as i128;
    let total = house.total_locked as i128 + delta;
    house.total_locked = u64::try_from(total).map_err(|_| BthError::MathOverflow)?;
    exposure.locked = new_locked;
    Ok(())
}

/// Milliseconds since the epoch from the cluster clock.
pub fn now_ms() -> Result<i64> {
    Ok(Clock::get()?
        .unix_timestamp
        .checked_mul(1000)
        .ok_or(BthError::MathOverflow)?)
}
