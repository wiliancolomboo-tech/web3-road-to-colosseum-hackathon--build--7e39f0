# 1. Clone repository and install dependencies
git clone https://github.com/streamsentry/streamsentry-protocol.git
cd streamsentry-protocol
npm install

# 2. Build Anchor Smart Contracts with deterministic build verifiable outputs
anchor build

# 3. Synchronize program ID (Anchor 0.30+)
solana address -k target/deploy/stream_sentry-keypair.json
# Verify output matches declare_id in lib.rs

# 4. Deploy to Solana Devnet / Testnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run full end-to-end QA validation suite
anchor test