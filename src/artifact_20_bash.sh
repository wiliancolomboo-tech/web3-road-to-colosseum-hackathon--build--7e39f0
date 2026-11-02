# 1. Install dependencies
yarn install

# 2. Build on-chain program artifact
anchor build

# 3. Synchronize generated program ID
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet