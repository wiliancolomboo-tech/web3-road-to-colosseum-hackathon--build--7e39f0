# Set cluster target
solana config set --url https://api.devnet.solana.com

# Build program binary
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Devnet
anchor deploy --program-name streamguard_protocol --provider.cluster Devnet