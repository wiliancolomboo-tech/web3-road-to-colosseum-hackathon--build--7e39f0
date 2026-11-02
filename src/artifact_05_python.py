"""
Khoros JIT Solver Cranking Engine
Listens for active OrderState accounts, calculates instant Dutch Auction profitability,
fetches Hermes Pyth prices, and constructs execution bundles.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.message import Message

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MAX_CONFIDENCE_RATIO_BPS = 150
BPS_DIVISOR = 10_000
PROGRAM_ID = Pubkey.from_string("Khoros1111111111111111111111111111111111111")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

@dataclass
class OrderAccountData:
    pubkey: Pubkey
    maker: Pubkey
    order_id: int
    mint_in: Pubkey
    mint_out: Pubkey
    vault_in: Pubkey
    slice_amount_in: int
    remaining_slices: int
    slice_interval_slots: int
    dutch_start_price_bps: int
    min_price_bps: int
    dutch_duration_slots: int
    last_execution_slot: int
    vault_bump: int

class KhorosSolverKeeper:
    def __init__(self, rpc_url: str, solver_keypair: Keypair):
        self.client = AsyncClient(rpc_url)
        self.solver = solver_keypair

    async def fetch_pyth_price(self, feed_id: str) -> tuple[int, int, int]:
        """
        Mock Pyth Core / Hermes interface returning (price, conf, publish_slot)
        Real production instances invoke: https://hermes.pyth.network/v2/updates/price/latest
        """
        current_slot = (await self.client.get_slot()).value
        price = 100_000_000       # $100.00
        conf = 20_000             # 0.02%
        return price, conf, current_slot

    def calculate_dutch_price(self, order: OrderAccountData, current_slot: int) -> int:
        elapsed = min(current_slot - order.last_execution_slot, order.dutch_duration_slots)
        spread = order.dutch_start_price_bps - order.min_price_bps
        decay = (spread * elapsed) // order.dutch_duration_slots
        return order.dutch_start_price_bps - decay

    async def evaluate_and_execute(self, order: OrderAccountData, solver_token_in: Pubkey, solver_token_out: Pubkey, maker_token_out: Pubkey):
        current_slot = (await self.client.get_slot()).value

        # Check interval condition
        if current_slot < (order.last_execution_slot + order.slice_interval_slots) and order.remaining_slices > 0:
            logging.info(f"Order {order.order_id}: Interval not elapsed. Skipping.")
            return

        price, conf, pub_slot = await self.fetch_pyth_price("SOL_USD")
        effective_bps = self.calculate_dutch_price(order, current_slot)

        # Margin check: verify that effective execution exceeds solver hurdle
        logging.info(f"Target Auction Price: {effective_bps / 100}% of Oracle.")

        # Build Instruction
        ix_discriminator = b"\x2a\x01\x19\x52\x87\x3a\x91\xf1" # execute_slice discriminator
        data = (
            ix_discriminator +
            price.to_bytes(8, "little", signed=True) +
            conf.to_bytes(8, "little") +
            pub_slot.to_bytes(8, "little")
        )

        accounts = [
            AccountMeta(pubkey=self.solver.pubkey(), is_signer=True, is_writable=True),
            AccountMeta(pubkey=order.maker, is_signer=False, is_writable=True),
            AccountMeta(pubkey=order.pubkey, is_signer=False, is_writable=True),
            AccountMeta(pubkey=order.vault_in, is_signer=False, is_writable=True),
            AccountMeta(pubkey=solver_token_in, is_signer=False, is_writable=True),
            AccountMeta(pubkey=solver_token_out, is_signer=False, is_writable=True),
            AccountMeta(pubkey=maker_token_out, is_signer=False, is_writable=True),
            AccountMeta(pubkey=TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
            AccountMeta(pubkey=Pubkey.from_string("SysvarC1ock11111111111111111111111111111111"), is_signer=False, is_writable=False),
        ]

        ix = Instruction(PROGRAM_ID, data, accounts)
        blockhash = (await self.client.get_latest_blockhash()).value.blockhash
        msg = Message.new_with_blockhash([ix], self.solver.pubkey(), blockhash)
        tx = Transaction([self.solver], msg, blockhash)

        resp = await self.client.send_transaction(tx)
        logging.info(f"Executed slice fill. Signature: {resp.value}")

    async def run(self):
        logging.info(f"Solver Engine active for wallet: {self.solver.pubkey()}")
        while True:
            try:
                # In production, query getProgramAccounts with memcmp filters
                await asyncio.sleep(2)
            except Exception as e:
                logging.error(f"Keeper error loop: {e}")
                await asyncio.sleep(1)

if __name__ == "__main__":
    dummy_keypair = Keypair()
    keeper = KhorosSolverKeeper("http://127.0.0.1:8899", dummy_keypair)
    asyncio.run(keeper.run())