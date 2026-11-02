# 1. Clone repository & install dependencies
git clone https://github.com/aether-vault/solana-mvp.git
cd solana-mvp
npm install

# 2. Build the optimized Anchor program
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Execute End-to-End Test Suite against Localnet/Devnet
anchor test --provider.cluster localnet