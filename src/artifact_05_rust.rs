use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("Aegis111111111111111111111111111111111111111");

pub const MAX_MILESTONES: usize = 10;
pub const ESCROW_SEED: &[u8] = b"escrow_state";
pub const VAULT_SEED: &[u8] = b"escrow_vault";

#[program]
pub mod aegisflow {
    use super::*;

    /// Initializes a new conditional milestone escrow.
    /// Deposits initial funds from depositor directly into the escrow vault PDA.
    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        escrow_id: u64,
        milestones: Vec<MilestoneInput>,
    ) -> Result<()> {
        require!(!milestones.is_empty(), AegisError::ZeroMilestones);
        require!(milestones.len() <= MAX_MILESTONES, AegisError::TooManyMilestones);

        let mut total_amount: u64 = 0;
        let clock = Clock::get()?;
        let mut parsed_milestones: [Milestone; MAX_MILESTONES] = [Milestone::default(); MAX_MILESTONES];

        for (i, m) in milestones.iter().enumerate() {
            require!(m.amount > 0, AegisError::InvalidMilestoneAmount);
            require!(
                m.unlock_timestamp > clock.unix_timestamp,
                AegisError::UnlockTimeInPast
            );
            total_amount = total_amount
                .checked_add(m.amount)
                .ok_or(AegisError::ArithmeticOverflow)?;

            parsed_milestones[i] = Milestone {
                amount: m.amount,
                unlock_timestamp: m.unlock_timestamp,
                status: MilestoneStatus::Pending,
            };
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.depositor = ctx.accounts.depositor.key();
        escrow.beneficiary = ctx.accounts.beneficiary.key();
        escrow.arbitrator = ctx.accounts.arbitrator.key();
        escrow.escrow_id = escrow_id;
        escrow.total_amount = total_amount;
        escrow.amount_claimed = 0;
        escrow.milestone_count = milestones.len() as u8;
        escrow.milestones = parsed_milestones;
        escrow.status = EscrowStatus::Active;
        escrow.bump = ctx.bumps.escrow;
        escrow.vault_bump = ctx.bumps.vault;

        // Transfer funds from depositor to the vault PDA
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            total_amount,
        )?;

        emit!(EscrowCreatedEvent {
            escrow_id,
            depositor: ctx.accounts.depositor.key(),
            beneficiary: ctx.accounts.beneficiary.key(),
            arbitrator: ctx.accounts.arbitrator.key(),
            total_amount,
            milestone_count: milestones.len() as u8,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claims an unlocked milestone.
    /// Can be executed by the beneficiary, or an autonomous keeper crank on beneficiary's behalf.
    pub fn claim_milestone(
        ctx: Context<ClaimMilestone>,
        _escrow_id: u64,
        milestone_index: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let clock = Clock::get()?;

        require!(escrow.status == EscrowStatus::Active, AegisError::EscrowNotActive);
        require!(
            (milestone_index as usize) < (escrow.milestone_count as usize),
            AegisError::MilestoneIndexOutOfBounds
        );

        let milestone = &mut escrow.milestones[milestone_index as usize];
        require!(
            milestone.status == MilestoneStatus::Pending,
            AegisError::MilestoneAlreadyProcessed
        );
        require!(
            clock.unix_timestamp >= milestone.unlock_timestamp,
            AegisError::MilestoneTimelocked
        );

        let claim_amount = milestone.amount;
        milestone.status = MilestoneStatus::Claimed;
        escrow.amount_claimed = escrow
            .amount_claimed
            .checked_add(claim_amount)
            .ok_or(AegisError::ArithmeticOverflow)?;

        // Check if all milestones have been claimed
        let mut all_claimed = true;
        for i in 0..(escrow.milestone_count as usize) {
            if escrow.milestones[i].status != MilestoneStatus::Claimed {
                all_claimed = false;
                break;
            }
        }
        if all_claimed {
            escrow.status = EscrowStatus::Completed;
        }

        // Transfer SOL from PDA vault to beneficiary
        let escrow_id_bytes = escrow.escrow_id.to_le_bytes();
        let seeds = &[
            VAULT_SEED,
            escrow_id_bytes.as_ref(),
            &[escrow.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let vault_info = ctx.accounts.vault.to_account_info();
        let beneficiary_info = ctx.accounts.beneficiary.to_account_info();

        **vault_info.try_borrow_mut_lamports()? = vault_info
            .lamports()
            .checked_sub(claim_amount)
            .ok_or(AegisError::InsufficientVaultBalance)?;

        **beneficiary_info.try_borrow_mut_lamports()? = beneficiary_info
            .lamports()
            .checked_add(claim_amount)
            .ok_or(AegisError::ArithmeticOverflow)?;

        emit!(MilestoneClaimedEvent {
            escrow_id: escrow.escrow_id,
            milestone_index,
            amount: claim_amount,
            beneficiary: ctx.accounts.beneficiary.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Freezes an escrow when a deliverable fails quality verification.
    /// Can only be called by the Depositor or Arbitrator.
    pub fn raise_dispute(ctx: Context<RaiseDispute>, _escrow_id: u64, reason: String) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Active, AegisError::EscrowNotActive);

        let clock = Clock::get()?;
        escrow.status = EscrowStatus::Disputed;

        emit!(DisputeRaisedEvent {
            escrow_id: escrow.escrow_id,
            initiator: ctx.accounts.caller.key(),
            reason,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Resolves an active dispute. Exclusively invokable by the designated Arbitrator.
    /// Distributes remaining lamports between Beneficiary and Depositor, closing the vault.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        _escrow_id: u64,
        beneficiary_split_bps: u16,
    ) -> Result<()> {
        require!(beneficiary_split_bps <= 10_000, AegisError::InvalidBps);
        let escrow = &mut ctx.accounts.escrow;
        require!(escrow.status == EscrowStatus::Disputed, AegisError::EscrowNotDisputed);

        let clock = Clock::get()?;
        let vault_lamports = ctx.accounts.vault.lamports();
        require!(vault_lamports > 0, AegisError::EmptyVault);

        let beneficiary_portion = (vault_lamports as u128)
            .checked_mul(beneficiary_split_bps as u128)
            .ok_or(AegisError::ArithmeticOverflow)?
            .checked_div(10_000)
            .ok_or(AegisError::ArithmeticOverflow)? as u64;

        let depositor_portion = vault_lamports
            .checked_sub(beneficiary_portion)
            .ok_or(AegisError::ArithmeticOverflow)?;

        let vault_info = ctx.accounts.vault.to_account_info();
        let beneficiary_info = ctx.accounts.beneficiary.to_account_info();
        let depositor_info = ctx.accounts.depositor.to_account_info();

        if beneficiary_portion > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(beneficiary_portion)
                .ok_or(AegisError::InsufficientVaultBalance)?;
            **beneficiary_info.try_borrow_mut_lamports()? = beneficiary_info
                .lamports()
                .checked_add(beneficiary_portion)
                .ok_or(AegisError::ArithmeticOverflow)?;
        }

        if depositor_portion > 0 {
            **vault_info.try_borrow_mut_lamports()? = vault_info
                .lamports()
                .checked_sub(depositor_portion)
                .ok_or(AegisError::InsufficientVaultBalance)?;
            **depositor_info.try_borrow_mut_lamports()? = depositor_info
                .lamports()
                .checked_add(depositor_portion)
                .ok_or(AegisError::ArithmeticOverflow)?;
        }

        escrow.status = EscrowStatus::Refunded;

        emit!(DisputeResolvedEvent {
            escrow_id: escrow.escrow_id,
            arbitrator: ctx.accounts.arbitrator.key(),
            beneficiary_amount: beneficiary_portion,
            depositor_amount: depositor_portion,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Closes an escrow account whose lifecycle is finished (Completed or Refunded) and returns rent to depositor.
    pub fn close_escrow(ctx: Context<CloseEscrow>, _escrow_id: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            escrow.status == EscrowStatus::Completed || escrow.status == EscrowStatus::Refunded,
            AegisError::EscrowNotFinished
        );
        require!(
            ctx.accounts.vault.lamports() == 0,
            AegisError::VaultNotEmpty
        );

        emit!(EscrowClosedEvent {
            escrow_id: escrow.escrow_id,
            closed_by: ctx.accounts.depositor.key(),
            timestamp: Clock::get()?.unix_timestamp,
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
    #[account(
        init,
        payer = depositor,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [ESCROW_SEED, depositor.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowState>,

    /// CHECK: Safe PDA derived account acting as Native SOL Vault.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    /// CHECK: Arbitrary recipient account.
    pub beneficiary: AccountInfo<'info>,

    /// CHECK: Validated designated arbitrator pubkey.
    pub arbitrator: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct ClaimMilestone<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.depositor.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump,
        has_one = beneficiary @ AegisError::UnauthorizedBeneficiary,
    )]
    pub escrow: Account<'info, EscrowState>,

    /// CHECK: Native SOL vault PDA validated by seeds and bump.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    /// CHECK: Verified against escrow.beneficiary.
    #[account(mut)]
    pub beneficiary: AccountInfo<'info>,

    /// Caller can be the beneficiary OR any keeper crank.
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct RaiseDispute<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.depositor.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump,
        constraint = (caller.key() == escrow.depositor || caller.key() == escrow.arbitrator) @ AegisError::UnauthorizedDisputeCaller
    )]
    pub escrow: Account<'info, EscrowState>,

    pub caller: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct ResolveDispute<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.depositor.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump,
        has_one = arbitrator @ AegisError::UnauthorizedArbitrator,
        has_one = depositor @ AegisError::InvalidDepositorAccount,
        has_one = beneficiary @ AegisError::UnauthorizedBeneficiary
    )]
    pub escrow: Account<'info, EscrowState>,

    /// CHECK: Native SOL vault PDA.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    pub arbitrator: Signer<'info>,

    /// CHECK: Escrow depositor.
    #[account(mut)]
    pub depositor: AccountInfo<'info>,

    /// CHECK: Escrow beneficiary.
    #[account(mut)]
    pub beneficiary: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CloseEscrow<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, depositor.key().as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump,
        has_one = depositor @ AegisError::UnauthorizedDepositor,
        close = depositor
    )]
    pub escrow: Account<'info, EscrowState>,

    /// CHECK: Must have zero balance.
    #[account(
        mut,
        seeds = [VAULT_SEED, escrow_id.to_le_bytes().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: AccountInfo<'info>,

    #[account(mut)]
    pub depositor: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE AND INPUT DEFINITIONS
// -----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Active,
    Disputed,
    Completed,
    Refunded,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MilestoneStatus {
    Pending,
    Claimed,
    Cancelled,
}

impl Default for MilestoneStatus {
    fn default() -> Self {
        MilestoneStatus::Pending
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Milestone {
    pub amount: u64,
    pub unlock_timestamp: i64,
    pub status: MilestoneStatus,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct MilestoneInput {
    pub amount: u64,
    pub unlock_timestamp: i64,
}

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub arbitrator: Pubkey,
    pub escrow_id: u64,
    pub total_amount: u64,
    pub amount_claimed: u64,
    pub milestone_count: u8,
    pub milestones: [Milestone; MAX_MILESTONES],
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct EscrowCreatedEvent {
    pub escrow_id: u64,
    pub depositor: Pubkey,
    pub beneficiary: Pubkey,
    pub arbitrator: Pubkey,
    pub total_amount: u64,
    pub milestone_count: u8,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneClaimedEvent {
    pub escrow_id: u64,
    pub milestone_index: u8,
    pub amount: u64,
    pub beneficiary: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct DisputeRaisedEvent {
    pub escrow_id: u64,
    pub initiator: Pubkey,
    pub reason: String,
    pub timestamp: i64,
}

#[event]
pub struct DisputeResolvedEvent {
    pub escrow_id: u64,
    pub arbitrator: Pubkey,
    pub beneficiary_amount: u64,
    pub depositor_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EscrowClosedEvent {
    pub escrow_id: u64,
    pub closed_by: Pubkey,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum AegisError {
    #[msg("Milestone array cannot be empty.")]
    ZeroMilestones,
    #[msg("Exceeded maximum supported milestones.")]
    TooManyMilestones,
    #[msg("Milestone amount must be strictly greater than zero.")]
    InvalidMilestoneAmount,
    #[msg("Milestone unlock timestamp must be in the future.")]
    UnlockTimeInPast,
    #[msg("Arithmetic overflow detected.")]
    ArithmeticOverflow,
    #[msg("Escrow is not in active state.")]
    EscrowNotActive,
    #[msg("Invalid milestone index.")]
    MilestoneIndexOutOfBounds,
    #[msg("Milestone has already been claimed or cancelled.")]
    MilestoneAlreadyProcessed,
    #[msg("Milestone timelock has not expired yet.")]
    MilestoneTimelocked,
    #[msg("Vault has insufficient balance.")]
    InsufficientVaultBalance,
    #[msg("Only the designated beneficiary or keeper may trigger milestone processing.")]
    UnauthorizedBeneficiary,
    #[msg("Only depositor or arbitrator can raise a dispute.")]
    UnauthorizedDisputeCaller,
    #[msg("Only the designated arbitrator can resolve disputes.")]
    UnauthorizedArbitrator,
    #[msg("Escrow is not in disputed state.")]
    EscrowNotDisputed,
    #[msg("Basis points parameter must be between 0 and 10000.")]
    InvalidBps,
    #[msg("Vault is completely empty.")]
    EmptyVault,
    #[msg("Escrow is not in a terminal state (Completed or Refunded).")]
    EscrowNotFinished,
    #[msg("Vault must be completely drained before account closure.")]
    VaultNotEmpty,
    #[msg("Unauthorized depositor signer.")]
    UnauthorizedDepositor,
    #[msg("Depositor account does not match state.")]
    InvalidDepositorAccount,
}