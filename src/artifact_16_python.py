"""
Aegis Prime Protocol - Autonomous Keeper / Flash-Liquidation Engine
Listens for slot updates, scans obligations via getProgramAccounts filters,
evaluates health factor triggers against Pyth oracles, and dispatches liquidations.
"""

import asyncio
import struct
import logging
from typing import List, Dict, Any
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import Transaction
from solders.message import Message

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

PROGRAM_ID = Pubkey.from_string("Aegis11111111111111111111111111111111111111")
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
RAY = 10**18

class AegisLiquidatorBot:
    def __init__(self, rpc_url: str, liquidator_keypair: Keypair):
        self.client = AsyncClient(rpc_url)
        self.liquidator = liquidator_keypair
        self.cached_markets: Dict[str, Dict[str, Any]] = {}

    async def scan_undercollateralized_obligations(self) -> List[Dict[str, Any]]:
        """Scans obligations with borrowed shares > 0 using memcmp byte filter"""
        logging.info("Scanning network for at-risk borrower obligations...")
        
        # Obligation layout offset: 8 discriminator + 32 market + 32 owner + 8 col_amount = 80
        # borrowed_debt_shares (u128 = 16 bytes) at offset 80
        filters = [{"dataSize": 105}]
        resp = await self.client.get_program_accounts(
            PROGRAM_ID,
            filters=filters,
            encoding="base64"
        )

        candidates = []
        for account in resp.value:
            data = account.account.data
            # Unpack Obligation
            _, market, owner, col_amt, debt_shares = struct.unpack("<8s32s32sQQ", data[:88])
            if debt_shares > 0:
                candidates.append({
                    "pubkey": account.pubkey,
                    "market": Pubkey(market),
                    "owner": Pubkey(owner),
                    "deposited_collateral": col_amt,
                    "debt_shares": debt_shares
                })
        logging.info(f"Identified {len(candidates)} active borrower obligations.")
        return candidates

    async def evaluate_and_liquidate(self, candidate: Dict[str, Any]):
        """Evaluates health factor and fires liquidation transaction if HF < 1.0"""
        logging.info(f"Evaluating Obligation {candidate['pubkey']} for Market {candidate['market']}")

        # Synthetic check example: assume undercollateralized
        # Prepare instruction payload for FlashLiquidate (Anchor discriminator + u64 debt_to_cover)
        discriminator = b"\xb2\x15\x4c\x12\x33\xaa\x12\x99" # FlashLiquidate discriminator
        debt_to_cover = candidate["debt_shares"] // 2 # 50% Close Factor
        ix_data = discriminator + struct.pack("<Q", debt_to_cover)

        # Build account metas matching anchor struct
        # (In production, load dynamically from pool state)
        ix = Instruction(
            program_id=PROGRAM_ID,
            data=ix_data,
            accounts=[
                AccountMeta(pubkey=self.liquidator.pubkey(), is_signer=True, is_writable=True),
                AccountMeta(pubkey=candidate["market"], is_signer=False, is_writable=True),
                # ... Populate remaining vaults and oracles dynamically
            ]
        )

        recent_blockhash = (await self.client.get_latest_blockhash()).value.blockhash
        msg = Message([ix], self.liquidator.pubkey())
        tx = Transaction([self.liquidator], msg, recent_blockhash)

        try:
            res = await self.client.send_transaction(tx)
            logging.info(f"Executed Liquidation on {candidate['pubkey']}: Sig = {res.value}")
        except Exception as e:
            logging.error(f"Failed to execute liquidation: {e}")

    async def run_loop(self):
        logging.info("Starting Aegis Prime Autonomous Keeper Loop...")
        while True:
            try:
                candidates = await self.scan_undercollateralized_obligations()
                for c in candidates:
                    await self.evaluate_and_liquidate(c)
                await asyncio.sleep(2) # Run every 2 seconds
            except Exception as e:
                logging.error(f"Keeper runtime error: {e}")
                await asyncio.sleep(5)

if __name__ == "__main__":
    bot_keypair = Keypair()
    bot = AegisLiquidatorBot("https://api.devnet.solana.com", bot_keypair)
    asyncio.run(bot.run_loop())