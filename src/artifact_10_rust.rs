use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::errors::AegisError;
use crate::events::EscrowInitialized;
use crate::state::{EscrowAccount, EscrowStatus};

#[derive(Accounts)]
#[instruction(task_id: u64)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub delegator: Signer<'info>,

    /// CHECK: Identity of the assigned AI worker or service entity
    pub designated_worker: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = delegator_token_account.owner == delegator.key(),
        constraint = delegator_token_account.mint == mint.key()
    )]
    pub delegator_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = delegator,
        space = EscrowAccount::LEN,
        seeds = [b"escrow", delegator.key().as_ref(), &task_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        init,
        payer = delegator,
        seeds = [b"vault", escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeEscrow>,
    task_id: u64,
    task_hash: [u8; 32],
    amount: u64,
    timeout_seconds: i64,
) -> Result<()> {
    require!(amount > 0, AegisError::ZeroDepositAmount);
    require!(timeout_seconds > 0, AegisError::InvalidDeadline);

    let clock = Clock::get()?;
    let deadline = clock
        .unix_timestamp
        .checked_add(timeout_seconds)
        .ok_or(AegisError::NumericalOverflow)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.delegator = ctx.accounts.delegator.key();
    escrow.designated_worker = ctx.accounts.designated_worker.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.vault = ctx.accounts.vault.key();
    escrow.task_id = task_id;
    escrow.task_hash = task_hash;
    escrow.result_hash = [0u8; 32];
    escrow.escrow_amount = amount;
    escrow.created_at = clock.unix_timestamp;
    escrow.deadline = deadline;
    escrow.status = EscrowStatus::Pending;
    escrow.bump = ctx.bumps.escrow;
    escrow.vault_bump = ctx.bumps.vault;

    // Deposit tokens from delegator to PDA vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.delegator_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.delegator.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    emit!(EscrowInitialized {
        task_id,
        delegator: ctx.accounts.delegator.key(),
        worker: ctx.accounts.designated_worker.key(),
        mint: ctx.accounts.mint.key(),
        amount,
        deadline,
    });

    Ok(())
}