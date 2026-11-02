# 1. Build and verify the Anchor program
anchor build

# 2. Deploy to Solana Devnet
solana program deploy ./target/deploy/aegis_escrow.so --program-id ./target/deploy/aegis_escrow-keypair.json

# 3. Execute Automated QA Test Suite
anchor test --skip-local-validator

# 4. Spin up the Background Telemetry Daemon
docker compose up -d --build
docker compose logs -f