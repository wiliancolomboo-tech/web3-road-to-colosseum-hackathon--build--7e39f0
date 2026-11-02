use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::errors::AegisError;
use crate::events::EscrowRefunded;
use crate::state::{EscrowAccount, EscrowStatus};

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: Delegator public key saved in escrow
    #[account(
        mut,
        constraint = escrow.delegator == delegator.key()
    )]
    pub delegator: AccountInfo<'info>,

    #[account(
        mut,
        constraint = escrow.status == EscrowStatus::Pending @ AegisError::InvalidEscrowStatus,
        seeds = [b"escrow", delegator.key().as_ref(), &escrow.task_id.to_le_bytes()],
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
        constraint = delegator_token_account.owner == delegator.key(),
        constraint = delegator_token_account.mint == escrow.mint
    )]
    pub delegator_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > ctx.accounts.escrow.deadline,
        AegisError::DeadlineNotReached
    );

    let escrow_key = ctx.accounts.escrow.key();
    let vault_bump = ctx.accounts.escrow.vault_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"vault",
        escrow_key.as_ref(),
        &[vault_bump],
    ]];

    let refund_amount = ctx.accounts.vault.amount;

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.delegator_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, refund_amount)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.status = EscrowStatus::Refunded;

    emit!(EscrowRefunded {
        task_id: escrow.task_id,
        delegator: ctx.accounts.delegator.key(),
        refunded_amount: refund_amount,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}