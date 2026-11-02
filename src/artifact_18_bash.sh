#!/usr/bin/env bash
set -euo pipefail

echo "===> [1/4] Building AegisGuard Anchor Smart Contract..."
anchor build

echo "===> [2/4] Deploying to Solana Devnet..."
PROGRAM_KEYPAIR="./target/deploy/aegisguard-keypair.json"
anchor deploy --provider.cluster devnet --program-keypair "$PROGRAM_KEYPAIR"

echo "===> [3/4] Initializing Node Environment..."
cd client
npm install
npm run build

echo "===> [4/4] Starting Autonomous Containerized Services..."
docker compose up -d --build

echo "===> AegisGuard MVP is Live on Devnet & Fully Autonomous."