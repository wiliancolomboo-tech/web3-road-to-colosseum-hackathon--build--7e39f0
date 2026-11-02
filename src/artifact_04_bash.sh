# 1. Configure Solana to Localnet
solana config set --url localhost

# 2. Generate deployment keypairs
solana-keygen new --no-bip39-passphrase --outfile ~/.config/solana/id.json -f

# 3. Clone and install project dependencies
git clone https://github.com/aetheris-protocol/aetheris-mvp.git
cd aetheris-mvp
yarn install