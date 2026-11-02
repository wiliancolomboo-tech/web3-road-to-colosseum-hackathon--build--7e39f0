# 1. Install Solana CLI & Anchor
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1
avm use 0.30.1

# 2. Build Smart Contract
anchor build

# 3. Synchronize Program ID Keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 3
anchor deploy --provider.cluster devnet