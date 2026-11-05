# 1. Build Solana Anchor Program
anchor build

# 2. Deploy Program to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy

# 3. Verify Program ID
export PROGRAM_ID=$(solana address -k target/deploy/zenith_pay-keypair.json)
echo "Deployed ZenithPay Program ID: $PROGRAM_ID"

# 4. Run Complete Integration Test Matrix
anchor test

# 5. Launch Keeper Daemon via Docker Compose
export RESEND_API_KEY="re_test_000000000000000000000000"
export DISCORD_WEBHOOK_URL="https://api.example.com/webhooks/alerts/placeholder"
docker compose up -d --build

# 6. Verify Service Telemetry & Logs
docker compose logs -f zenith-keeper