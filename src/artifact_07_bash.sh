# 1. Clone repository and install dependencies
git clone https://github.com/chronolock-protocol/chronolock-solana.git
cd chronolock-solana
npm install -g @coral-xyz/anchor-cli
yarn install

# 2. Build Anchor binary with deterministic verifiable BPF compiler
anchor build

# 3. Synchronize program ID into Anchor.toml and lib.rs
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Execute complete verification test suite
anchor test