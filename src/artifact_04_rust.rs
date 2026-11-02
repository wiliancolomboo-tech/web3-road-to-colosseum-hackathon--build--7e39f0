use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as system_transfer, Transfer as SystemTransfer};

declare_id!("Chrno7Yq91R3KzUeN9r62v9eYtYFw5e8qM3v8b2b7jKL");

#[program]
pub mod chrono_lock {
    use super::*;

    /// Initializes a milestone-based conditional escrow vault with locked SOL.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        total_amount: u64,
        milestone_count: u8,
        dispute_window_seconds: i64,
        milestone_hashes: Vec<[u8; 32]>,
        milestone_amounts: Vec<u64>,
    ) -> Result<()> {
        require!(milestone_count > 0, ChronoLockError::ZeroMilestones);
        require!(
            milestone_count as usize == milestone_hashes.len(),
            ChronoLockError::MilestoneMismatch
        );
        require!(
            milestone_count as usize == milestone_amounts.len(),
            ChronoLockError::MilestoneMismatch
        );

        let calculated_sum: u64 = milestone_amounts.iter().sum();
        require!(
            calculated_sum == total_amount,
            ChronoLockError::InvalidMilestoneSum
        );
        require!(
            total_amount > 0,
            ChronoLockError::ZeroTotalAmount
        );
        require!(
            dispute_window_seconds >= 60,
            ChronoLockError::DisputeWindowTooShort
        );

        let escrow = &mut ctx.accounts.escrow_state;
        escrow.sponsor = ctx.accounts.sponsor.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.escrow_id = escrow_id;
        escrow.total_amount = total_amount;
        escrow.remaining_balance = total_amount;
        escrow.milestone_count = milestone_count;
        escrow.current_milestone = 0;
        escrow.dispute_window_seconds = dispute_window_seconds;
        escrow.state = EscrowStateEnum::Active;
        escrow.created_at = Clock::get()?.unix_timestamp;
        escrow.last_submission_time = 0;
        escrow.bump = ctx.bumps.escrow_state;
        escrow.vault_bump = ctx.bumps.vault;

        // Copy milestone metadata into static-capacity storage
        for i in 0..milestone_count as usize {
            escrow.milestones[i] = MilestoneItem {
                expected_hash: milestone_hashes[i],
                submitted_hash: [0u8; 32],
                amount: milestone_amounts[i],
                status: MilestoneStatus::Pending,
            };
        }

        // Fund the Escrow Vault PDA directly via System Program
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SystemTransfer {
                from: ctx.accounts.sponsor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_transfer(cpi_context, total_amount)?;

        emit!(EscrowInitializedEvent {
            escrow_id,
            sponsor: ctx.accounts.sponsor.key(),
            beneficiary: ctx.accounts.beneficiary.key(),
            total_amount,
            milestone_count,
            timestamp: escrow.created_at,
        });

        Ok(())
    }

    /// Submits a milestone proof (SHA-256 digest of PR, artifact, or TEE attestation).
    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        deliverable_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStateEnum::Active,
            ChronoLockError::EscrowNotActive
        );
        let curr = escrow.current_milestone as usize;
        require!(
            curr < escrow.milestone_count as usize,
            ChronoLockError::AllMilestonesCompleted
        );

        let milestone = &mut escrow.milestones[curr];
        require!(
            milestone.status == MilestoneStatus::Pending,
            ChronoLockError::MilestoneAlreadySubmitted
        );

        // Verification against the expected milestone commitment hash
        require!(
            milestone.expected_hash == deliverable_hash,
            ChronoLockError::HashMismatch
        );

        milestone.submitted_hash = deliverable_hash;
        milestone.status = MilestoneStatus::Submitted;
        let now = Clock::get()?.unix_timestamp;
        escrow.last_submission_time = now;

        emit!(MilestoneSubmittedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index: curr as u8,
            deliverable_hash,
            submitted_at: now,
        });

        Ok(())
    }

    /// Approves current milestone and releases funds to beneficiary.
    pub fn approve_milestone(ctx: Context<ApproveMilestone>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStateEnum::Active,
            ChronoLockError::EscrowNotActive
        );

        let curr = escrow.current_milestone as usize;
        require!(
            curr < escrow.milestone_count as usize,
            ChronoLockError::AllMilestonesCompleted
        );

        let milestone = &mut escrow.milestones[curr];
        require!(
            milestone.status == MilestoneStatus::Submitted,
            ChronoLockError::MilestoneNotSubmitted
        );

        let release_amount = milestone.amount;
        require!(
            escrow.remaining_balance >= release_amount,
            ChronoLockError::InsufficientVaultBalance
        );

        // Disburse funds directly from Vault PDA to Beneficiary
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let sponsor_key = escrow.sponsor;
        let seeds: &[&[u8]] = &[
            b"vault",
            sponsor_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= release_amount;
        **ctx.accounts.beneficiary.to_account_info().try_borrow_mut_lamports()? += release_amount;

        milestone.status = MilestoneStatus::Approved;
        escrow.remaining_balance = escrow
            .remaining_balance
            .checked_sub(release_amount)
            .ok_or(ChronoLockError::MathOverflow)?;
        escrow.current_milestone = escrow
            .current_milestone
            .checked_add(1)
            .ok_or(ChronoLockError::MathOverflow)?;

        if escrow.current_milestone == escrow.milestone_count {
            escrow.state = EscrowStateEnum::Completed;
        }

        emit!(MilestoneApprovedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index: curr as u8,
            amount_released: release_amount,
            remaining_balance: escrow.remaining_balance,
        });

        Ok(())
    }

    /// Autonomous keeper release invoked if sponsor is inactive beyond the dispute window.
    pub fn keeper_auto_release(ctx: Context<KeeperAutoRelease>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStateEnum::Active,
            ChronoLockError::EscrowNotActive
        );

        let curr = escrow.current_milestone as usize;
        require!(
            curr < escrow.milestone_count as usize,
            ChronoLockError::AllMilestonesCompleted
        );

        let milestone = &mut escrow.milestones[curr];
        require!(
            milestone.status == MilestoneStatus::Submitted,
            ChronoLockError::MilestoneNotSubmitted
        );

        let now = Clock::get()?.unix_timestamp;
        let eligible_release_time = escrow
            .last_submission_time
            .checked_add(escrow.dispute_window_seconds)
            .ok_or(ChronoLockError::MathOverflow)?;

        require!(
            now >= eligible_release_time,
            ChronoLockError::DisputeWindowStillActive
        );

        let release_amount = milestone.amount;
        require!(
            escrow.remaining_balance >= release_amount,
            ChronoLockError::InsufficientVaultBalance
        );

        // Sign transfer using Vault PDA
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let sponsor_key = escrow.sponsor;
        let seeds: &[&[u8]] = &[
            b"vault",
            sponsor_key.as_ref(),
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ];

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= release_amount;
        **ctx.accounts.beneficiary.to_account_info().try_borrow_mut_lamports()? += release_amount;

        milestone.status = MilestoneStatus::Approved;
        escrow.remaining_balance = escrow
            .remaining_balance
            .checked_sub(release_amount)
            .ok_or(ChronoLockError::MathOverflow)?;
        escrow.current_milestone = escrow
            .current_milestone
            .checked_add(1)
            .ok_or(ChronoLockError::MathOverflow)?;

        if escrow.current_milestone == escrow.milestone_count {
            escrow.state = EscrowStateEnum::Completed;
        }

        emit!(MilestoneAutoReleasedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index: curr as u8,
            amount_released: release_amount,
            keeper: ctx.accounts.keeper.key(),
            timestamp: now,
        });

        Ok(())
    }

    /// Sponsor opens a dispute before the dispute window lapses.
    pub fn raise_dispute(ctx: Context<RaiseDispute>, reason_code: u16) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStateEnum::Active,
            ChronoLockError::EscrowNotActive
        );

        let curr = escrow.current_milestone as usize;
        require!(
            curr < escrow.milestone_count as usize,
            ChronoLockError::AllMilestonesCompleted
        );

        let milestone = &mut escrow.milestones[curr];
        require!(
            milestone.status == MilestoneStatus::Submitted,
            ChronoLockError::MilestoneNotSubmitted
        );

        let now = Clock::get()?.unix_timestamp;
        let deadline = escrow
            .last_submission_time
            .checked_add(escrow.dispute_window_seconds)
            .ok_or(ChronoLockError::MathOverflow)?;

        require!(now < deadline, ChronoLockError::DisputeWindowExpired);

        milestone.status = MilestoneStatus::Disputed;
        escrow.state = EscrowStateEnum::Disputed;

        emit!(DisputeRaisedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index: curr as u8,
            sponsor: ctx.accounts.sponsor.key(),
            reason_code,
            timestamp: now,
        });

        Ok(())
    }

    /// Emergency clawback by sponsor if no milestone has been submitted within 30 days.
    pub fn cancel_inactive_escrow(ctx: Context<CancelInactiveEscrow>) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(
            escrow.state == EscrowStateEnum::Active,
            ChronoLockError::EscrowNotActive
        );
        require!(
            escrow.current_milestone == 0,
            ChronoLockError::MilestonesAlreadyStarted
        );

        let now = Clock::get()?.unix_timestamp;
        let inactivity_limit = 30 * 86400; // 30 days
        require!(
            now >= escrow.created_at + inactivity_limit,
            ChronoLockError::InactivityPeriodNotMet
        );

        let reclaim_amount = escrow.remaining_balance;
        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= reclaim_amount;
        **ctx.accounts.sponsor.to_account_info().try_borrow_mut_lamports()? += reclaim_amount;

        escrow.remaining_balance = 0;
        escrow.state = EscrowStateEnum::Cancelled;

        emit!(EscrowCancelledEvent {
            escrow_id: escrow.escrow_id,
            reclaimed_amount: reclaim_amount,
            timestamp: now,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,

    /// CHECK: Beneficiary is an unchecked public address receiving milestones.
    pub beneficiary: AccountInfo<'info>,

    #[account(
        init,
        payer = sponsor,
        space = 8 + EscrowState::MAX_SIZE,
        seeds = [b"escrow", sponsor.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Vault PDA derived deterministically holding native lamports.
    #[account(
        mut,
        seeds = [b"vault", sponsor.key().as_ref(), escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitMilestone<'info> {
    #[account(
        mut,
        constraint = beneficiary.key() == escrow_state.beneficiary @ ChronoLockError::UnauthorizedBeneficiary
    )]
    pub beneficiary: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct ApproveMilestone<'info> {
    #[account(
        mut,
        constraint = sponsor.key() == escrow_state.sponsor @ ChronoLockError::UnauthorizedSponsor
    )]
    pub sponsor: Signer<'info>,

    /// CHECK: Validated against escrow_state.beneficiary.
    #[account(
        mut,
        constraint = beneficiary.key() == escrow_state.beneficiary @ ChronoLockError::BeneficiaryMismatch
    )]
    pub beneficiary: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Validated against PDA seeds.
    #[account(
        mut,
        seeds = [b"vault", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.vault_bump
    )]
    pub vault: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct KeeperAutoRelease<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// CHECK: Validated against escrow_state.beneficiary.
    #[account(
        mut,
        constraint = beneficiary.key() == escrow_state.beneficiary @ ChronoLockError::BeneficiaryMismatch
    )]
    pub beneficiary: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Validated against PDA seeds.
    #[account(
        mut,
        seeds = [b"vault", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.vault_bump
    )]
    pub vault: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(
        constraint = sponsor.key() == escrow_state.sponsor @ ChronoLockError::UnauthorizedSponsor
    )]
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,
}

#[derive(Accounts)]
pub struct CancelInactiveEscrow<'info> {
    #[account(
        mut,
        constraint = sponsor.key() == escrow_state.sponsor @ ChronoLockError::UnauthorizedSponsor
    )]
    pub sponsor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"escrow", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.bump
    )]
    pub escrow_state: Account<'info, EscrowState>,

    /// CHECK: Validated against PDA seeds.
    #[account(
        mut,
        seeds = [b"vault", escrow_state.sponsor.as_ref(), escrow_state.escrow_id.to_le_bytes().as_ref()],
        bump = escrow_state.vault_bump
    )]
    pub vault: AccountInfo<'info>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTURES
// -----------------------------------------------------------------------------

pub const MAX_MILESTONES: usize = 8;

#[account]
pub struct EscrowState {
    pub sponsor: Pubkey,               // 32
    pub beneficiary: Pubkey,           // 32
    pub escrow_id: u64,                // 8
    pub total_amount: u64,             // 8
    pub remaining_balance: u64,        // 8
    pub milestone_count: u8,           // 1
    pub current_milestone: u8,         // 1
    pub dispute_window_seconds: i64,   // 8
    pub state: EscrowStateEnum,        // 1
    pub created_at: i64,               // 8
    pub last_submission_time: i64,     // 8
    pub bump: u8,                      // 1
    pub vault_bump: u8,                // 1
    pub milestones: [MilestoneItem; MAX_MILESTONES], // (32 + 32 + 8 + 1) * 8 = 73 * 8 = 584
}

impl EscrowState {
    pub const MAX_SIZE: usize = 32 + 32 + 8 + 8 + 8 + 1 + 1 + 8 + 1 + 8 + 8 + 1 + 1 + (73 * MAX_MILESTONES) + 64;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub struct MilestoneItem {
    pub expected_hash: [u8; 32],
    pub submitted_hash: [u8; 32],
    pub amount: u64,
    pub status: MilestoneStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStateEnum {
    Active,
    Completed,
    Disputed,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    Approved,
    Disputed,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowInitializedEvent {
    pub escrow_id: u64,
    pub sponsor: Pubkey,
    pub beneficiary: Pubkey,
    pub total_amount: u64,
    pub milestone_count: u8,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneSubmittedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub deliverable_hash: [u8; 32],
    pub submitted_at: i64,
}

#[event]
pub struct MilestoneApprovedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub amount_released: u64,
    pub remaining_balance: u64,
}

#[event]
pub struct MilestoneAutoReleasedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub amount_released: u64,
    pub keeper: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DisputeRaisedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub sponsor: Pubkey,
    pub reason_code: u16,
    pub timestamp: i64,
}

#[event]
pub struct EscrowCancelledEvent {
    pub escrow_id: u64,
    pub reclaimed_amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// CUSTOM ERRORS
// -----------------------------------------------------------------------------

#[error_code]
pub enum ChronoLockError {
    #[msg("Milestone count must be greater than zero")]
    ZeroMilestones,
    #[msg("Supplied milestone parameters do not match milestone_count")]
    MilestoneMismatch,
    #[msg("Sum of milestone amounts must equal the total deposit amount")]
    InvalidMilestoneSum,
    #[msg("Total deposit amount must be greater than zero")]
    ZeroTotalAmount,
    #[msg("Dispute window must be at least 60 seconds")]
    DisputeWindowTooShort,
    #[msg("Escrow is not in Active state")]
    EscrowNotActive,
    #[msg("All milestones for this escrow have already been completed")]
    AllMilestonesCompleted,
    #[msg("Current milestone is already submitted")]
    MilestoneAlreadySubmitted,
    #[msg("Deliverable hash does not match pre-committed milestone hash")]
    HashMismatch,
    #[msg("Milestone must be submitted prior to approval or auto-release")]
    MilestoneNotSubmitted,
    #[msg("Insufficient vault balance to satisfy disbursement")]
    InsufficientVaultBalance,
    #[msg("Dispute window is still active; autonomous keeper cannot release yet")]
    DisputeWindowStillActive,
    #[msg("Dispute window has elapsed; cannot raise dispute")]
    DisputeWindowExpired,
    #[msg("Milestones have already started; emergency cancellation is locked")]
    MilestonesAlreadyStarted,
    #[msg("Inactivity threshold of 30 days has not elapsed")]
    InactivityPeriodNotMet,
    #[msg("Unauthorized beneficiary key provided")]
    UnauthorizedBeneficiary,
    #[msg("Unauthorized sponsor key provided")]
    UnauthorizedSponsor,
    #[msg("Beneficiary account mismatch")]
    BeneficiaryMismatch,
    #[msg("Arithmetic overflow occurred")]
    MathOverflow,
}