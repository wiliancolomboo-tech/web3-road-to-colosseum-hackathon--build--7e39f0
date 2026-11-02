use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::AegisError;
use crate::events::TaskFulfilled;
use crate::state::{EscrowAccount, EscrowStatus};

#[derive(Accounts)]
pub struct FulfillTask<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,

    #[account(
        mut,
        constraint = escrow.status == EscrowStatus::Pending @ AegisError::InvalidEscrowStatus,
        constraint = escrow.designated_worker == worker.key() @ AegisError::UnauthorizedWorker,
        seeds = [b"escrow", escrow.delegator.as_ref(), &escrow.task_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(
        mut,
        seeds = [b"vault", escrow.key().as_ref()],
        bump = escrow.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = worker_token_account.owner == worker.key(),
        constraint = worker_token_account.mint == escrow.mint
    )]
    pub worker_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<FulfillTask>, result_hash: [u8; 32]) -> Result<()> {
    require!(result_hash != [0u8; 32], AegisError::InvalidResultHash);

    let clock = Clock::get()?;
    require!(clock.unix_timestamp <= ctx.accounts.escrow.deadline, AegisError::EscrowExpired);

    let escrow_key = ctx.accounts.escrow.key();
    let vault_bump = ctx.accounts.escrow.vault_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        escrow_key.as_ref(),
        &[vault_bump],
    ]];

    let payout = ctx.accounts.escrow.escrow_amount;

    // Transfer token from PDA Vault to Worker
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.worker_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, payout)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.status = EscrowStatus::Fulfilled;
    escrow.result_hash = result_hash;

    emit!(TaskFulfilled {
        task_id: escrow.task_id,
        worker: ctx.accounts.worker.key(),
        result_hash,
        payout_amount: payout,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}