use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("AethrV1111111111111111111111111111111111111");

#[program]
pub mod aether_vault {
    use super::*;

    pub fn initialize_circuit_breaker(
        ctx: Context<InitializeCircuitBreaker>,
        max_epoch_outflow: u64,
        epoch_duration_seconds: i64,
    ) -> Result<()> {
        require!(max_epoch_outflow > 0, AetherError::InvalidVelocityLimit);
        require!(epoch_duration_seconds > 0, AetherError::InvalidDuration);

        let circuit_breaker = &mut ctx.accounts.circuit_breaker;
        circuit_breaker.authority = ctx.accounts.authority.key();
        circuit_breaker.max_epoch_outflow = max_epoch_outflow;
        circuit_breaker.epoch_accumulated_volume = 0;
        circuit_breaker.epoch_start_time = Clock::get()?.unix_timestamp;
        circuit_breaker.epoch_duration_seconds = epoch_duration_seconds;
        circuit_breaker.is_frozen = false;
        circuit_breaker.bump = ctx.bumps.circuit_breaker;

        emit!(CircuitBreakerInitializedEvent {
            authority: circuit_breaker.authority,
            max_epoch_outflow,
            epoch_duration_seconds,
            timestamp: circuit_breaker.epoch_start_time,
        });

        Ok(())
    }

    pub fn update_circuit_breaker_status(
        ctx: Context<UpdateCircuitBreakerStatus>,
        is_frozen: bool,
    ) -> Result<()> {
        let circuit_breaker = &mut ctx.accounts.circuit_breaker;
        circuit_breaker.is_frozen = is_frozen;

        emit!(CircuitBreakerStatusUpdatedEvent {
            authority: ctx.accounts.authority.key(),
            is_frozen,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        amount: u64,
        timeout_seconds: i64,
        deliverable_hash: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, AetherError::ZeroTransferAmount);
        require!(timeout_seconds >= 60, AetherError::TimeoutTooShort);

        let circuit_breaker = &ctx.accounts.circuit_breaker;
        require!(!circuit_breaker.is_frozen, AetherError::CircuitBreakerFrozen);

        // Populate Escrow State
        let escrow = &mut ctx.accounts.escrow_account;
        escrow.escrow_id = escrow_id;
        escrow.buyer = ctx.accounts.buyer.key();
        escrow.recipient = ctx.accounts.recipient.key();
        escrow.circuit_breaker = circuit_breaker.key();
        escrow.amount = amount;
        escrow.deliverable_hash = deliverable_hash;
        escrow.status = EscrowStatus::Active;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.expires_at = escrow.created_at + timeout_seconds;
        escrow.bump = ctx.bumps.escrow_account;

        // Perform Native SOL Transfer to Escrow PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.buyer.to_account_info(),
                to: ctx.accounts.escrow_account.to_account_info(),
            },
        );
        transfer(cpi_context, amount)?;

        emit!(EscrowCreatedEvent {
            escrow_id,
            buyer: escrow.buyer,
            recipient: escrow.recipient,
            amount,
            expires_at: escrow.expires_at,
            deliverable_hash,
        });

        Ok(())
    }

    pub fn complete_and_release(
        ctx: Context<CompleteAndRelease>,
        submitted_hash: [u8; 32],
    ) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow_account;
        let circuit_breaker = &mut ctx.accounts.circuit_breaker;

        require!(!circuit_breaker.is_frozen, AetherError::CircuitBreakerFrozen);
        require!(escrow.status == EscrowStatus::Active, AetherError::InvalidEscrowStatus);
        require!(
            escrow.deliverable_hash == [0u8; 32] || escrow.deliverable_hash == submitted_hash,
            AetherError::DeliverableHashMismatch
        );

        // Verify and update circuit breaker epoch window
        if current_time >= circuit_breaker.epoch_start_time + circuit_breaker.epoch_duration_seconds {
            circuit_breaker.epoch_start_time = current_time;
            circuit_breaker.epoch_accumulated_volume = 0;
        }

        let prospective_volume = circuit_breaker
            .epoch_accumulated_volume
            .checked_add(escrow.amount)
            .ok_or(AetherError::MathOverflow)?;

        require!(
            prospective_volume <= circuit_breaker.max_epoch_outflow,
            AetherError::VelocityThresholdExceeded
        );

        // Update circuit state
        circuit_breaker.epoch_accumulated_volume = prospective_volume;
        escrow.status = EscrowStatus::Completed;

        // Direct Lamports transfer from Escrow PDA to recipient
        **escrow.to_account_info().try_borrow_mut_lamports()? -= escrow.amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += escrow.amount;

        emit!(EscrowCompletedEvent {
            escrow_id: escrow.escrow_id,
            buyer: escrow.buyer,
            recipient: escrow.recipient,
            amount: escrow.amount,
            timestamp: current_time,
        });

        Ok(())
    }

    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        let current_time = Clock::get()?.unix_timestamp;
        let escrow = &mut ctx.accounts.escrow_account;

        require!(escrow.status == EscrowStatus::Active, AetherError::InvalidEscrowStatus);
        require!(current_time > escrow.expires_at, AetherError::EscrowNotExpired);

        escrow.status = EscrowStatus::Refunded;
        let refund_amount = escrow.amount;

        **escrow.to_account_info().try_borrow_mut_lamports()? -= refund_amount;
        **ctx.accounts.buyer.try_borrow_mut_lamports()? += refund_amount;

        emit!(EscrowRefundedEvent {
            escrow_id: escrow.escrow_id,
            buyer: escrow.buyer,
            amount: refund_amount,
            timestamp: current_time,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeCircuitBreaker<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = CircuitBreaker::SPACE,
        seeds = [b"circuit_breaker", authority.key().as_ref()],
        bump
    )]
    pub circuit_breaker: Account<'info, CircuitBreaker>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateCircuitBreakerStatus<'info> {
    #[account(
        mut,
        has_one = authority @ AetherError::UnauthorizedCircuitAuthority
    )]
    pub circuit_breaker: Account<'info, CircuitBreaker>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: Recipient is arbitrary valid account receiving release payout
    pub recipient: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"circuit_breaker", circuit_breaker.authority.as_ref()],
        bump = circuit_breaker.bump
    )]
    pub circuit_breaker: Account<'info, CircuitBreaker>,

    #[account(
        init,
        payer = buyer,
        space = EscrowAccount::SPACE,
        seeds = [b"escrow", buyer.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompleteAndRelease<'info> {
    #[account(
        mut,
        constraint = buyer.key() == escrow_account.buyer @ AetherError::UnauthorizedBuyer
    )]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        constraint = recipient.key() == escrow_account.recipient @ AetherError::InvalidRecipient
    )]
    /// CHECK: Validated against stored escrow account recipient
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        constraint = escrow_account.circuit_breaker == circuit_breaker.key() @ AetherError::CircuitBreakerMismatch
    )]
    pub circuit_breaker: Account<'info, CircuitBreaker>,

    #[account(
        mut,
        seeds = [b"escrow", buyer.key().as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
}

#[derive(Accounts)]
pub struct RefundExpired<'info> {
    #[account(
        mut,
        constraint = buyer.key() == escrow_account.buyer @ AetherError::UnauthorizedBuyer
    )]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", buyer.key().as_ref(), &escrow_account.escrow_id.to_le_bytes()],
        bump = escrow_account.bump
    )]
    pub escrow_account: Account<'info, EscrowAccount>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTURES
// -----------------------------------------------------------------------------

#[account]
pub struct CircuitBreaker {
    pub authority: Pubkey,
    pub max_epoch_outflow: u64,
    pub epoch_accumulated_volume: u64,
    pub epoch_start_time: i64,
    pub epoch_duration_seconds: i64,
    pub is_frozen: bool,
    pub bump: u8,
}

impl CircuitBreaker {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStatus {
    Active,
    Completed,
    Refunded,
    Disputed,
}

#[account]
pub struct EscrowAccount {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub recipient: Pubkey,
    pub circuit_breaker: Pubkey,
    pub amount: u64,
    pub deliverable_hash: [u8; 32],
    pub status: EscrowStatus,
    pub created_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

impl EscrowAccount {
    pub const SPACE: usize = 8 + 8 + 32 + 32 + 32 + 8 + 32 + 1 + 8 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct CircuitBreakerInitializedEvent {
    pub authority: Pubkey,
    pub max_epoch_outflow: u64,
    pub epoch_duration_seconds: i64,
    pub timestamp: i64,
}

#[event]
pub struct CircuitBreakerStatusUpdatedEvent {
    pub authority: Pubkey,
    pub is_frozen: bool,
    pub timestamp: i64,
}

#[event]
pub struct EscrowCreatedEvent {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
    pub deliverable_hash: [u8; 32],
}

#[event]
pub struct EscrowCompletedEvent {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EscrowRefundedEvent {
    pub escrow_id: u64,
    pub buyer: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum AetherError {
    #[msg("Velocity threshold must be greater than zero")]
    InvalidVelocityLimit,
    #[msg("Epoch duration must be greater than zero")]
    InvalidDuration,
    #[msg("Transfer amount must be greater than zero")]
    ZeroTransferAmount,
    #[msg("Escrow duration must be at least 60 seconds")]
    TimeoutTooShort,
    #[msg("Circuit breaker is actively frozen")]
    CircuitBreakerFrozen,
    #[msg("Action not allowed in current escrow state")]
    InvalidEscrowStatus,
    #[msg("Submitted deliverable hash does not match escrow condition")]
    DeliverableHashMismatch,
    #[msg("Total outflow exceeds circuit breaker maximum velocity limit for this epoch")]
    VelocityThresholdExceeded,
    #[msg("Arithmetic overflow occurred")]
    MathOverflow,
    #[msg("Escrow timeout has not yet elapsed")]
    EscrowNotExpired,
    #[msg("Unauthorized buyer account supplied")]
    UnauthorizedBuyer,
    #[msg("Provided recipient does not match escrow destination")]
    InvalidRecipient,
    #[msg("Supplied circuit breaker does not match escrow parameters")]
    CircuitBreakerMismatch,
    #[msg("Unauthorized circuit authority")]
    UnauthorizedCircuitAuthority,
}