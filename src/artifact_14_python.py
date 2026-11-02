#!/usr/bin/env python3
"""
AegisVault Autonomous Rebalance Keeper
Monitors pool metrics and triggers sync_rebalance to adjust utilization kinks.
"""

import asyncio
import logging
import os
import sys
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solana.rpc.async_api import AsyncClient
from anchorpy import Provider, Wallet, Program, Idl
import json

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] (AegisKeeper) %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

RPC_ENDPOINT = os.getenv("SOLANA_RPC_ENDPOINT", "http://127.0.0.1:8899")
PROGRAM_ID = Pubkey.from_string("AegisV1111111111111111111111111111111111111")

class VaultKeeperBot:
    def __init__(self, keypair_path: str, idl_path: str):
        with open(keypair_path, "r") as f:
            secret = json.load(f)
            self.wallet_keypair = Keypair.from_bytes(bytes(secret))
        
        with open(idl_path, "r") as f:
            self.idl = Idl.from_json(f.read())

        self.client = AsyncClient(RPC_ENDPOINT)
        self.provider = Provider(self.client, Wallet(self.wallet_keypair))
        self.program = Program(self.idl, PROGRAM_ID, self.provider)
        logging.info(f"Initialized Keeper with Authority: {self.wallet_keypair.pubkey()}")

    async def fetch_market_volatility_index(self) -> int:
        """
        Simulates oracle pull from Pyth / Switchboard.
        Returns basis points index where > 5000 is volatile.
        """
        # In production: Fetch Hermes Pyth Price Update VAA
        await asyncio.sleep(0.1)
        import random
        return random.randint(3000, 7500)

    async def execute_crank_cycle(self, vault_pda: Pubkey):
        while True:
            try:
                volatility = await self.fetch_market_volatility_index()
                logging.info(f"Observed Volatility Metric: {volatility} bps")

                tx = await self.program.methods.sync_rebalance(volatility).accounts({
                    "keeper": self.wallet_keypair.pubkey(),
                    "vault_state": vault_pda,
                }).rpc()

                logging.info(f"Crank executed successfully! TX Signature: {tx}")
            except Exception as e:
                logging.error(f"Error during crank loop: {str(e)}")

            await asyncio.sleep(3)

async def main():
    if len(sys.argv) < 3:
        print("Usage: python keeper.py <PATH_TO_KEYPAIR> <PATH_TO_IDL> <VAULT_PDA>")
        sys.exit(1)

    keypair_path = sys.argv[1]
    idl_path = sys.argv[2]
    vault_pda = Pubkey.from_string(sys.argv[3])

    bot = VaultKeeperBot(keypair_path, idl_path)
    await bot.execute_crank_cycle(vault_pda)

if __name__ == "__main__":
    asyncio.run(main())