# 1. Build optimized BPF bytecode with verifiable Anchor build
anchor build --verifiable

# 2. Configure network targeting (Devnet)
solana config set --url https://api.devnet.solana.com
solana airdrop 2

# 3. Synchronize program keys and deploy
solana program deploy ./target/deploy/aegisflow.so --program-id Aegis11111111111111111111111111111111111111

# 4. Verify deployment signature
solana program show Aegis11111111111111111111111111111111111111