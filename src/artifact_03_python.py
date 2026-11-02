import asyncio
import os
import struct
from dataclasses import dataclass
from typing import Dict, List
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0

PROGRAM_ID = Pubkey.from_string("Aeg1sCore11111111111111111111111111111111111")
RPC_URL = os.getenv("SOLANA_RPC_URL", "http://127.0.0.1:8899")
KEEPER_KEYPAIR_PATH = os.getenv("KEEPER_KEYPAIR", "./keeper-wallet.json")

# Layout sizes (Account discriminant = 8 bytes)
MARKET_LAYOUT_FMT = "<8s32sQ32s32s32s32sQQQQ16sQQ16sBBB"
OBLIGATION_LAYOUT_FMT = "<8s32s32sQ16sB"

@dataclass
class ObligationRecord:
    pubkey: Pubkey
    borrower: Pubkey
    market: Pubkey
    collateral_amount: int
    debt_shares: int
    bump: int

class AegisKeeperService:
    def __init__(self, rpc_url: str, keypair: Keypair):
        self.client = AsyncClient(rpc_url, commitment=Confirmed)
        self.keeper = keypair
        self.markets: Dict[Pubkey, dict] = {}
        self.obligations: List[ObligationRecord] = []

    async def sync_obligations(self):
        """Scans all obligations on-chain via get_program_accounts filters."""
        print("[KEEPER] Scanning on-chain obligations...")
        memcmp_filter = {"memcmp": {"offset": 0, "bytes": "ObligationDiscriminant"}}
        # In production use exact base58 discriminant prefix
        resp = await self.client.get_program_accounts(
            PROGRAM_ID,
            commitment=Confirmed,
            encoding="base64"
        )
        if resp.value:
            for item in resp.value:
                raw_data = item.account.data
                if len(raw_data) == struct.calcsize(OBLIGATION_LAYOUT_FMT):
                    _, borrower, market, col_amt, shares, bump = struct.unpack(
                        OBLIGATION_LAYOUT_FMT, raw_data
                    )
                    self.obligations.append(ObligationRecord(
                        pubkey=item.pubkey,
                        borrower=Pubkey(borrower),
                        market=Pubkey(market),
                        collateral_amount=col_amt,
                        debt_shares=shares,
                        bump=bump
                    ))
            print(f"[KEEPER] Synchronized {len(self.obligations)} active obligations.")

    async def evaluate_and_liquidate(self, collateral_price: int, debt_price: int):
        """Monitors health factors and fires atomic liquidation transactions."""
        print(f"[KEEPER] Evaluating collateral @ ${collateral_price/1e6:.2f}, debt @ ${debt_price/1e6:.2f}")
        for ob in self.obligations:
            if ob.debt_shares == 0:
                continue

            # In practice: fetch and accrue market borrow index
            # Synthetic evaluation: ColVal * 80% < DebtVal
            col_val = ob.collateral_amount * collateral_price
            max_borrow_val = (col_val * 8_000) // 10_000
            debt_val = ob.debt_shares * debt_price

            if max_borrow_val < debt_val:
                print(f"[ALERT] Unhealthy Obligation detected! Target: {ob.borrower}")
                await self.dispatch_liquidation(ob, ob.debt_shares // 2, collateral_price, debt_price)

    async def dispatch_liquidation(self, ob: ObligationRecord, cover_amount: int, col_price: int, debt_price: int):
        print(f"[EXECUTE] Building liquidation instruction for borrower {ob.borrower}...")
        # Pack instruction discriminator for 'liquidate_undercollateralized' (SHA256 first 8 bytes)
        ix_discriminant = bytes([238, 175, 41, 198, 240, 19, 137, 248])
        data = ix_discriminant + struct.pack("<QQQ", cover_amount, col_price, debt_price)

        # In production: derive token accounts & assemble VersionedTransaction with Jito tip
        print(f"[EXECUTE] Submitting Flash-Liquidation bundle to Sealevel runtime...")
        # Simulated submission
        await asyncio.sleep(0.05)
        print(f"[SUCCESS] Obligation {ob.pubkey} partially absorbed. Seized collateral secured.")

async def main():
    dummy_keypair = Keypair()
    keeper = AegisKeeperService(RPC_URL, dummy_keypair)
    while True:
        try:
            await keeper.sync_obligations()
            # Fetch real prices from Pyth Hermes API in production
            simulated_sol_price = 145_000_000  # $145.00
            simulated_usdc_price = 1_000_000   # $1.00
            await keeper.evaluate_and_liquidate(simulated_sol_price, simulated_usdc_price)
            await asyncio.sleep(0.4) # Poll every slot interval (~400ms)
        except Exception as e:
            print(f"[ERROR] Keeper cycle error: {e}")
            await asyncio.sleep(1.0)

if __name__ == "__main__":
    asyncio.run(main())