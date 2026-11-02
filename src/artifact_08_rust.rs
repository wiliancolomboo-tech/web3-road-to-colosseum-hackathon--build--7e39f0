use anchor_lang::prelude::*;

#[event]
pub struct EscrowInitialized {
    pub task_id: u64,
    pub delegator: Pubkey,
    pub worker: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub deadline: i64,
}

#[event]
pub struct TaskFulfilled {
    pub task_id: u64,
    pub worker: Pubkey,
    pub result_hash: [u8; 32],
    pub payout_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EscrowRefunded {
    pub task_id: u64,
    pub delegator: Pubkey,
    pub refunded_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct EscrowCancelled {
    pub task_id: u64,
    pub delegator: Pubkey,
    pub returned_amount: u64,
    pub timestamp: i64,
}