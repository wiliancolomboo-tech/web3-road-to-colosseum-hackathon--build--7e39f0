use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{StreamAccount, StreamStatus};
use crate::errors::StreamError;
use crate::events::StreamCanceledEvent;

#[derive(Accounts)]
pub struct CancelStream<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        constraint = stream_account.sender == sender.key() @ StreamError::UnauthorizedAction,
        constraint = stream_account.cancelable @ StreamError::StreamNotCancelable,
        constraint = stream_account.status == StreamStatus::Active || stream_account.status == StreamStatus::Paused
            @ StreamError::StreamClosed
    )]
    pub stream_account: Account<'info, StreamAccount>,

    #[account(
        mut,
        seeds = [b"stream_vault", stream_account.key().as_ref()],
        bump = stream_account.vault_bump
    )]
    pub escrow_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key()
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == stream_account.recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelStream>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let stream = &mut ctx.accounts.stream_account;

    let claimable = stream.calculate_claimable_amount(now);
    let total_remaining_escrow = ctx.accounts.escrow_vault.amount;
    let refund_to_sender = total_remaining_escrow.saturating_sub(claimable);

    let stream_key = stream.key();
    let seeds = &[
        b"stream_vault",
        stream_key.as_ref(),
        &[stream.vault_bump],
    ];
    let signer = &[&seeds[..]];

    if claimable > 0 {
        let recipient_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            },
            signer,
        );
        token::transfer(recipient_cpi, claimable)?;
    }

    if refund_to_sender > 0 {
        let sender_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.sender_token_account.to_account_info(),
                authority: ctx.accounts.escrow_vault.to_account_info(),
            },
            signer,
        );
        token::transfer(sender_cpi, refund_to_sender)?;
    }

    stream.withdrawn_amount = stream.withdrawn_amount.saturating_add(claimable);
    stream.status = StreamStatus::Canceled;

    emit!(StreamCanceledEvent {
        stream_id: stream.stream_id,
        refund_to_sender,
        final_payout_to_recipient: claimable,
        timestamp: now,
    });

    Ok(())
}