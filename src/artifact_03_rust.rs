use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Aegis111111111111111111111111111111111111111");

pub const VAULT_SEED: &[u8] = b"aegis_vault";
pub const RESERVE_SEED: &[u8] = b"aegis_reserve";
pub const SESSION_SEED: &[u8] = b"aegis_session";

#[program]
pub mod aegis_stream {
    use super::*;

    /// Initialize the Aegis defense vault and custody reserve.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        min_health_threshold_bps: u16,
        cooldown_slots: u64,
    ) -> Result<()> {
        require!(min_health_threshold_bps <= 10_000, AegisError::InvalidThreshold);

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.mint = ctx.accounts.mint.key();
        vault.reserve_account = ctx.accounts.reserve_account.key();
        vault.target_collateral_account = ctx.accounts.target_collateral_account.key();
        vault.min_health_threshold_bps = min_health_threshold_bps;
        vault.cooldown_slots = cooldown_slots;
        vault.last_defend_slot = 0;
        vault.total_defended_amount = 0;
        vault.is_paused = false;
        vault.bump = ctx.bumps.vault;
        vault.reserve_bump = ctx.bumps.reserve_account;

        emit!(VaultInitializedEvent {
            vault: vault.key(),
            authority: vault.authority,
            mint: vault.mint,
            min_health_threshold_bps,
        });

        Ok(())
    }

    /// Authorize a scoped execution session key for the autonomous keeper.
    pub fn create_session(
        ctx: Context<CreateSession>,
        max_amount_per_execution: u64,
        max_cumulative_amount: u64,
        expires_at_slot: u64,
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        require!(expires_at_slot > current_slot, AegisError::InvalidExpiry);
        require!(max_amount_per_execution > 0, AegisError::ZeroAmount);
        require!(max_cumulative_amount >= max_amount_per_execution, AegisError::InvalidSessionCap);

        let session = &mut ctx.accounts.session;
        session.vault = ctx.accounts.vault.key();
        session.keeper = ctx.accounts.keeper.key();
        session.max_amount_per_execution = max_amount_per_execution;
        session.max_cumulative_amount = max_cumulative_amount;
        session.cumulative_spent = 0;
        session.expires_at_slot = expires_at_slot;
        session.is_revoked = false;
        session.bump = ctx.bumps.session;

        emit!(SessionCreatedEvent {
            vault: session.vault,
            keeper: session.keeper,
            max_amount_per_execution,
            max_cumulative_amount,
            expires_at_slot,
        });

        Ok(())
    }

    /// Revoke a session key immediately.
    pub fn revoke_session(ctx: Context<RevokeSession>) -> Result<()> {
        let session = &mut ctx.accounts.session;
        session.is_revoked = true;

        emit!(SessionRevokedEvent {
            vault: session.vault,
            keeper: session.keeper,
        });

        Ok(())
    }

    /// Emergency pause/unpause for multi-sig authority.
    pub fn set_paused(ctx: Context<SetPaused>, is_paused: bool) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.is_paused = is_paused;

        emit!(VaultPauseToggledEvent {
            vault: vault.key(),
            is_paused,
        });

        Ok(())
    }

    /// Execute automated defense top-up. Can ONLY transfer from reserve to the pre-agreed target collateral account.
    pub fn execute_defense(
        ctx: Context<ExecuteDefense>,
        amount: u64,
        observed_health_bps: u16,
    ) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let vault = &mut ctx.accounts.vault;
        let session = &mut ctx.accounts.session;

        // Invariant Verifications
        require!(!vault.is_paused, AegisError::VaultIsPaused);
        require!(!session.is_revoked, AegisError::SessionRevoked);
        require!(current_slot <= session.expires_at_slot, AegisError::SessionExpired);
        require!(
            current_slot >= vault.last_defend_slot.saturating_add(vault.cooldown_slots),
            AegisError::CooldownActive
        );
        require!(observed_health_bps <= vault.min_health_threshold_bps, AegisError::ThresholdNotBreached);
        require!(amount > 0 && amount <= session.max_amount_per_execution, AegisError::ExecutionCapExceeded);

        let new_cumulative = session.cumulative_spent
            .checked_add(amount)
            .ok_or(AegisError::MathOverflow)?;
        require!(new_cumulative <= session.max_cumulative_amount, AegisError::CumulativeCapExceeded);

        // Account destination constraints
        require_keys_eq!(
            ctx.accounts.target_collateral_account.key(),
            vault.target_collateral_account,
            AegisError::UnauthorizedDestination
        );

        // Execute deterministic SPL token transfer from Reserve PDA to Target Collateral Account
        let vault_key = vault.key();
        let seeds = &[
            RESERVE_SEED,
            vault_key.as_ref(),
            &[vault.reserve_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_cpi = Transfer {
            from: ctx.accounts.reserve_account.to_account_info(),
            to: ctx.accounts.target_collateral_account.to_account_info(),
            authority: ctx.accounts.reserve_account.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_cpi,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;

        // Update state
        session.cumulative_spent = new_cumulative;
        vault.last_defend_slot = current_slot;
        vault.total_defended_amount = vault.total_defended_amount
            .checked_add(amount)
            .ok_or(AegisError::MathOverflow)?;

        emit!(DefenseExecutedEvent {
            vault: vault.key(),
            keeper: session.keeper,
            amount,
            observed_health_bps,
            slot: current_slot,
            cumulative_spent: new_cumulative,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + VaultState::LEN,
        seeds = [VAULT_SEED, authority.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, VaultState>,

    #[account(
        init,
        payer = authority,
        seeds = [RESERVE_SEED, vault.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = reserve_account
    )]
    pub reserve_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    /// The institutional collateral account to be protected (e.g. Kamino or Marginfi supply vault).
    pub target_collateral_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateSession<'info> {
    #[account(
        mut,
        has_one = authority @ AegisError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, VaultState>,

    #[account(
        init,
        payer = authority,
        space = 8 + SessionState::LEN,
        seeds = [SESSION_SEED, vault.key().as_ref(), keeper.key().as_ref()],
        bump
    )]
    pub session: Account<'info, SessionState>,

    /// Autonomous keeper public key
    pub keeper: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevokeSession<'info> {
    #[account(has_one = authority @ AegisError::UnauthorizedAuthority)]
    pub vault: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [SESSION_SEED, vault.key().as_ref(), session.keeper.as_ref()],
        bump = session.bump
    )]
    pub session: Account<'info, SessionState>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        has_one = authority @ AegisError::UnauthorizedAuthority
    )]
    pub vault: Account<'info, VaultState>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteDefense<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.authority.as_ref(), vault.mint.as_ref()],
        bump = vault.bump
    )]
    pub vault: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [SESSION_SEED, vault.key().as_ref(), keeper.key().as_ref()],
        bump = session.bump,
        has_one = keeper @ AegisError::UnauthorizedKeeper
    )]
    pub session: Account<'info, SessionState>,

    #[account(
        mut,
        seeds = [RESERVE_SEED, vault.key().as_ref()],
        bump = vault.reserve_bump
    )]
    pub reserve_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = target_collateral_account.key() == vault.target_collateral_account @ AegisError::UnauthorizedDestination
    )]
    pub target_collateral_account: Account<'info, TokenAccount>,

    pub keeper: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// Data Structs & Event Schemas
// -----------------------------------------------------------------------------

#[account]
pub struct VaultState {
    pub authority: Pubkey,                 // 32
    pub mint: Pubkey,                      // 32
    pub reserve_account: Pubkey,           // 32
    pub target_collateral_account: Pubkey, // 32
    pub min_health_threshold_bps: u16,     // 2 (e.g., 1500 = 15.00% health factor)
    pub cooldown_slots: u64,               // 8
    pub last_defend_slot: u64,             // 8
    pub total_defended_amount: u64,        // 8
    pub is_paused: bool,                   // 1
    pub bump: u8,                          // 1
    pub reserve_bump: u8,                  // 1
}

impl VaultState {
    pub const LEN: usize = 32 + 32 + 32 + 32 + 2 + 8 + 8 + 8 + 1 + 1 + 1;
}

#[account]
pub struct SessionState {
    pub vault: Pubkey,                    // 32
    pub keeper: Pubkey,                   // 32
    pub max_amount_per_execution: u64,    // 8
    pub max_cumulative_amount: u64,       // 8
    pub cumulative_spent: u64,            // 8
    pub expires_at_slot: u64,             // 8
    pub is_revoked: bool,                 // 1
    pub bump: u8,                         // 1
}

impl SessionState {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

#[event]
pub struct VaultInitializedEvent {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub min_health_threshold_bps: u16,
}

#[event]
pub struct SessionCreatedEvent {
    pub vault: Pubkey,
    pub keeper: Pubkey,
    pub max_amount_per_execution: u64,
    pub max_cumulative_amount: u64,
    pub expires_at_slot: u64,
}

#[event]
pub struct SessionRevokedEvent {
    pub vault: Pubkey,
    pub keeper: Pubkey,
}

#[event]
pub struct VaultPauseToggledEvent {
    pub vault: Pubkey,
    pub is_paused: bool,
}

#[event]
pub struct DefenseExecutedEvent {
    pub vault: Pubkey,
    pub keeper: Pubkey,
    pub amount: u64,
    pub observed_health_bps: u16,
    pub slot: u64,
    pub cumulative_spent: u64,
}

#[error_code]
pub enum AegisError {
    #[msg("Invalid health factor threshold.")]
    InvalidThreshold,
    #[msg("Session expiry slot must be strictly in the future.")]
    InvalidExpiry,
    #[msg("Execution amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Session cap cannot be lower than single execution cap.")]
    InvalidSessionCap,
    #[msg("Caller is not authorized authority.")]
    UnauthorizedAuthority,
    #[msg("Caller is not authorized keeper.")]
    UnauthorizedKeeper,
    #[msg("Vault is currently paused by administrator.")]
    VaultIsPaused,
    #[msg("Session key has been revoked.")]
    SessionRevoked,
    #[msg("Session key has expired.")]
    SessionExpired,
    #[msg("Defense execution cooldown is still active.")]
    CooldownActive,
    #[msg("Collateral health ratio is above safeguard threshold.")]
    ThresholdNotBreached,
    #[msg("Requested amount exceeds single execution cap.")]
    ExecutionCapExceeded,
    #[msg("Requested amount exceeds cumulative session allowance.")]
    CumulativeCapExceeded,
    #[msg("Target account does not match designated vault collateral account.")]
    UnauthorizedDestination,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}