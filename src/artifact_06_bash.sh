# Build binary
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Solana Devnet
solana program deploy \
  --url https://api.devnet.solana.com \
  --program-id target/deploy/aegis_stream-keypair.json \
  target/deploy/aegis_stream.so