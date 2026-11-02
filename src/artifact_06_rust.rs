use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EscrowStatus {
    Pending,
    Fulfilled,
    Refunded,
    Cancelled,
}

#[account]
pub struct EscrowAccount {
    pub delegator: Pubkey,
    pub designated_worker: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub task_id: u64,
    pub task_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub escrow_amount: u64,
    pub created_at: i64,
    pub deadline: i64,
    pub status: EscrowStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

impl EscrowAccount {
    pub const LEN: usize = 8 + // discriminator
        32 + // delegator
        32 + // designated_worker
        32 + // mint
        32 + // vault
        8  + // task_id
        32 + // task_hash
        32 + // result_hash
        8  + // escrow_amount
        8  + // created_at
        8  + // deadline
        1  + // status (enum)
        1  + // bump
        1;   // vault_bump
}