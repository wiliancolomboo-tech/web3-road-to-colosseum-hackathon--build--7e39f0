use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("Krat111111111111111111111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"config";
pub const ORDER_SEED: &[u8] = b"order";
pub const VAULT_SEED: &[u8] = b"vault";

// Pyth SDK mock structure for explicit off-chain/on-chain zero-dependency validation
// In production, integrate pyth-sdk-solana
#[account]
pub struct PythPriceAccount {
    pub magic: u32,
    pub ver: u32,
    pub atype: u32,
    pub size: u32,
    pub price_type: u32,
    pub exponent: i32,
    pub num_quote_publishers: i32,
    pub num_publishers: i32,
    pub last_slot: u64,
    pub valid_slot: u64,
    pub twap: i64,
    pub twac: i64,
    pub drv1: u64,
    pub drv2: u64,
    pub product_account: Pubkey,
    pub next_price_account: Pubkey,
    pub prev_slot: u64,
    pub prev_price: i64,
    pub prev_confidence: u64,
    pub prev_timestamp: i64,
    pub agg_price: i64,
    pub agg_confidence: u64,
    pub agg_status: u32,
    pub agg_pub_slot: u64,
    pub agg_pub_timestamp: i64,
}

#[program]
pub mod kratos {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= 500, KratosError::FeeTooHigh); // Max 5%
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.fee_recipient = ctx.accounts.fee_recipient.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.is_paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_stream_order(
        ctx: Context<CreateStreamOrder>,
        order_id: u64,
        total_deposit: u64,
        tranche_amount: u64,
        interval_seconds: i64,
        min_price: u64,
        max_price: u64,
        keeper_incentive_bps: u16,
    ) -> Result<()> {
        require!(!ctx.accounts.config.is_paused, KratosError::ProtocolPaused);
        require!(total_deposit > 0, KratosError::InvalidDepositAmount);
        require!(
            tranche_amount > 0 && tranche_amount <= total_deposit,
            KratosError::InvalidTrancheAmount
        );
        require!(interval_seconds >= 5, KratosError::IntervalTooShort);
        require!(min_price <= max_price, KratosError::InvalidPriceBounds);
        require!(keeper_incentive_bps <= 250, KratosError::KeeperFeeTooHigh); // Max 2.5%

        let order = &mut ctx.accounts.order;
        order.owner = ctx.accounts.owner.key();
        order.order_id = order_id;
        order.input_mint = ctx.accounts.input_mint.key();
        order.output_mint = ctx.accounts.output_mint.key();
        order.oracle_feed = ctx.accounts.oracle_feed.key();
        order.total_deposit = total_deposit;
        order.remaining_deposit = total_deposit;
        order.tranche_amount = tranche_amount;
        order.interval_seconds = interval_seconds;
        order.min_price = min_price;
        order.max_price = max_price;
        order.last_execution_timestamp = 0;
        order.keeper_incentive_bps = keeper_incentive_bps;
        order.bump = ctx.bumps.order;
        order.vault_bump = ctx.bumps.vault;

        // Secure Deposit into Escrow Vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.owner_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, total_deposit)?;

        emit!(OrderCreatedEvent {
            order_id,
            owner: order.owner,
            input_mint: order.input_mint,
            total_deposit,
            tranche_amount,
        });

        Ok(())
    }

    pub fn execute_tranche(ctx: Context<ExecuteTranche>) -> Result<()> {
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;
        let order = &mut ctx.accounts.order;

        require!(!ctx.accounts.config.is_paused, KratosError::ProtocolPaused);
        require!(order.remaining_deposit > 0, KratosError::OrderAlreadyDepleted);

        // 1. Time-window validation
        require!(
            current_time.checked_sub(order.last_execution_timestamp).unwrap() >= order.interval_seconds,
            KratosError::IntervalNotElapsed
        );

        // 2. Oracle Verification & Staleness Checks
        let oracle_acc = &ctx.accounts.oracle_feed;
        require_keys_eq!(oracle_acc.key(), order.oracle_feed, KratosError::InvalidOracleFeed);
        
        let oracle_data = oracle_acc.try_borrow_data()?;
        require!(oracle_data.len() >= 136, KratosError::InvalidOracleData);
        
        // Minimal deserialization of Pyth Agg Price (offset 208 for agg_price, 224 for agg_pub_timestamp)
        let price_bytes: [u8; 8] = oracle_data[208..216].try_into().unwrap();
        let pub_time_bytes: [u8; 8] = oracle_data[224..232].try_into().unwrap();
        let price = i64::from_le_bytes(price_bytes);
        let publish_time = i64::from_le_bytes(pub_time_bytes);

        require!(price > 0, KratosError::InvalidPrice);
        let staleness = current_time.checked_sub(publish_time).unwrap_or(i64::MAX);
        require!(staleness <= 30 && staleness >= -5, KratosError::StaleOraclePrice);

        let u_price = price as u64;
        require!(
            u_price >= order.min_price && u_price <= order.max_price,
            KratosError::PriceOutOfBounds
        );

        // 3. Execution Math
        let executable_amount = std::cmp::min(order.remaining_deposit, order.tranche_amount);
        let keeper_fee = executable_amount
            .checked_mul(order.keeper_incentive_bps as u64)
            .ok_or(KratosError::ArithmeticError)?
            .checked_div(10000)
            .ok_or(KratosError::ArithmeticError)?;
        
        let protocol_fee = executable_amount
            .checked_mul(ctx.accounts.config.protocol_fee_bps as u64)
            .ok_or(KratosError::ArithmeticError)?
            .checked_div(10000)
            .ok_or(KratosError::ArithmeticError)?;

        let outbound_swap_amount = executable_amount
            .checked_sub(keeper_fee)
            .ok_or(KratosError::ArithmeticError)?
            .checked_sub(protocol_fee)
            .ok_or(KratosError::ArithmeticError)?;

        // Mutate Order State
        order.remaining_deposit = order
            .remaining_deposit
            .checked_sub(executable_amount)
            .ok_or(KratosError::ArithmeticError)?;
        order.last_execution_timestamp = current_time;

        // 4. CPI Dispatches from Vault PDA
        let order_id_bytes = order.order_id.to_le_bytes();
        let owner_key = order.owner;
        let seeds = &[
            ORDER_SEED,
            owner_key.as_ref(),
            order_id_bytes.as_ref(),
            &[order.bump],
        ];
        let vault_seeds = &[
            VAULT_SEED,
            order.to_account_info().key.as_ref(),
            &[order.vault_bump],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        // Keeper Payout
        if keeper_fee > 0 {
            let keeper_payout = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.keeper_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(keeper_payout, keeper_fee)?;
        }

        // Protocol Fee Payout
        if protocol_fee > 0 {
            let protocol_payout = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.protocol_fee_vault.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(protocol_payout, protocol_fee)?;
        }

        // Dispatch chunk to User Destination (or integrated swap router)
        let swap_outflow = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(swap_outflow, outbound_swap_amount)?;

        emit!(TrancheExecutedEvent {
            order: order.key(),
            executor: ctx.accounts.keeper.key(),
            amount: executable_amount,
            oracle_price: u_price,
            keeper_fee,
        });

        Ok(())
    }

    pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
        let order = &mut ctx.accounts.order;
        let remaining = order.remaining_deposit;

        if remaining > 0 {
            let order_key = order.key();
            let vault_seeds = &[
                VAULT_SEED,
                order_key.as_ref(),
                &[order.vault_bump],
            ];
            let signer_seeds = &[&vault_seeds[..]];

            let refund_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(refund_ctx, remaining)?;
        }

        // Close vault token account
        let order_key = order.key();
        let vault_seeds = &[
            VAULT_SEED,
            order_key.as_ref(),
            &[order.vault_bump],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        let close_vault_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_vault_ctx)?;

        emit!(OrderCancelledEvent {
            order: order.key(),
            refunded_amount: remaining,
        });

        Ok(())
    }
}

// ----------------------------- ACCOUNT CONTEXTS -----------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::SIZE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Protocol fee collector address
    pub fee_recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct CreateStreamOrder<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = owner,
        space = 8 + OrderState::SIZE,
        seeds = [ORDER_SEED, owner.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order: Account<'info, OrderState>,

    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump,
        token::mint = input_mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,
    /// CHECK: Verified via Pyth deserialization
    pub oracle_feed: AccountInfo<'info>,

    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == input_mint.key()
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ExecuteTranche<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [ORDER_SEED, order.owner.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, OrderState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: Dynamic Pyth price feed bound to order
    pub oracle_feed: AccountInfo<'info>,

    #[account(
        mut,
        constraint = keeper_token_account.mint == order.input_mint
    )]
    pub keeper_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination_token_account.mint == order.input_mint
    )]
    pub destination_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = protocol_fee_vault.mint == order.input_mint,
        constraint = protocol_fee_vault.owner == config.fee_recipient
    )]
    pub protocol_fee_vault: Account<'info, TokenAccount>,

    pub keeper: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    #[account(
        mut,
        close = owner,
        seeds = [ORDER_SEED, owner.key().as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump,
        has_one = owner
    )]
    pub order: Account<'info, OrderState>,

    #[account(
        mut,
        seeds = [VAULT_SEED, order.key().as_ref()],
        bump = order.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = owner_token_account.owner == owner.key(),
        constraint = owner_token_account.mint == order.input_mint
    )]
    pub owner_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ----------------------------- STATE SCHEMAS -----------------------------

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub protocol_fee_bps: u16,
    pub is_paused: bool,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const SIZE: usize = 32 + 32 + 2 + 1 + 1;
}

#[account]
pub struct OrderState {
    pub owner: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub oracle_feed: Pubkey,
    pub order_id: u64,
    pub total_deposit: u64,
    pub remaining_deposit: u64,
    pub tranche_amount: u64,
    pub min_price: u64,
    pub max_price: u64,
    pub last_execution_timestamp: i64,
    pub interval_seconds: i64,
    pub keeper_incentive_bps: u16,
    pub bump: u8,
    pub vault_bump: u8,
}

impl OrderState {
    pub const SIZE: usize = 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 2 + 1 + 1;
}

// ----------------------------- EVENTS & ERRORS -----------------------------

#[event]
pub struct OrderCreatedEvent {
    pub order_id: u64,
    pub owner: Pubkey,
    pub input_mint: Pubkey,
    pub total_deposit: u64,
    pub tranche_amount: u64,
}

#[event]
pub struct TrancheExecutedEvent {
    pub order: Pubkey,
    pub executor: Pubkey,
    pub amount: u64,
    pub oracle_price: u64,
    pub keeper_fee: u64,
}

#[event]
pub struct OrderCancelledEvent {
    pub order: Pubkey,
    pub refunded_amount: u64,
}

#[error_code]
pub enum KratosError {
    #[msg("Fee basis points exceeds safety threshold.")]
    FeeTooHigh,
    #[msg("Protocol operations are paused by authority.")]
    ProtocolPaused,
    #[msg("Deposit amount must be strictly greater than 0.")]
    InvalidDepositAmount,
    #[msg("Tranche chunk must be > 0 and <= total deposit.")]
    InvalidTrancheAmount,
    #[msg("Execution interval must be at least 5 seconds.")]
    IntervalTooShort,
    #[msg("Oracle price bounds are inverted.")]
    InvalidPriceBounds,
    #[msg("Keeper incentive exceeds max bound of 250 bps.")]
    KeeperFeeTooHigh,
    #[msg("Order remaining deposit is fully depleted.")]
    OrderAlreadyDepleted,
    #[msg("Tranche interval has not elapsed yet.")]
    IntervalNotElapsed,
    #[msg("Supplied oracle feed does not match order requirement.")]
    InvalidOracleFeed,
    #[msg("Pyth account data stream too small or corrupted.")]
    InvalidOracleData,
    #[msg("Pyth oracle price returned <= 0.")]
    InvalidPrice,
    #[msg("Oracle price feed is stale or outside timestamp confidence limits.")]
    StaleOraclePrice,
    #[msg("Current oracle price does not fall within order bound constraints.")]
    PriceOutOfBounds,
    #[msg("Math calculation encountered an overflow or division by zero.")]
    ArithmeticError,
}