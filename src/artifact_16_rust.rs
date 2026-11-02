use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Aegis11111111111111111111111111111111111111");

#[program]
pub mod aegis_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        authority: Pubkey,
        guardian: Pubkey,
        epoch_limit: u64,
        instant_threshold: u64,
        timelock_slots: u64,
    ) -> Result<()> {
        instructions::initialize_vault::handler(
            ctx,
            authority,
            guardian,
            epoch_limit,
            instant_threshold,
            timelock_slots,
        )
    }

    pub fn queue_disbursement(
        ctx: Context<QueueDisbursement>,
        disbursement_id: u64,
        amount: u64,
    ) -> Result<()> {
        instructions::queue_disbursement::handler(ctx, disbursement_id, amount)
    }

    pub fn execute_disbursement(
        ctx: Context<ExecuteDisbursement>,
        disbursement_id: u64,
    ) -> Result<()> {
        instructions::execute_disbursement::handler(ctx, disbursement_id)
    }

    pub fn trigger_circuit_breaker(ctx: Context<TriggerCircuitBreaker>) -> Result<()> {
        instructions::trigger_circuit_breaker::handler(ctx)
    }

    pub fn unpause_vault(ctx: Context<UnpauseVault>) -> Result<()> {
        instructions::unpause_vault::handler(ctx)
    }

    pub fn cancel_disbursement(
        ctx: Context<CancelDisbursement>,
        disbursement_id: u64,
    ) -> Result<()> {
        instructions::cancel_disbursement::handler(ctx, disbursement_id)
    }
}