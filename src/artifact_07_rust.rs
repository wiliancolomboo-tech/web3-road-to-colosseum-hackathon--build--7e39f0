use anchor_lang::prelude::*;

#[error_code]
pub enum AegisError {
    #[msg("Calculation overflow occurred during arithmetic execution.")]
    NumericalOverflow,
    #[msg("Escrow deadline must be set strictly in the future.")]
    InvalidDeadline,
    #[msg("Escrow amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("Current escrow status does not permit this transition.")]
    InvalidEscrowStatus,
    #[msg("Caller is unauthorized to fulfill this task commitment.")]
    UnauthorizedWorker,
    #[msg("Task execution deadline has expired.")]
    EscrowExpired,
    #[msg("Task execution deadline has not yet expired. Circuit breaker locked.")]
    DeadlineNotReached,
    #[msg("Escrow cancellation permitted only if task remains pending and unfulfilled.")]
    EscrowNotPending,
    #[msg("Supplied result hash is empty or mathematically invalid.")]
    InvalidResultHash,
}