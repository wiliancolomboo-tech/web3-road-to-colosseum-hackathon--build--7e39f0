# 1. Clone & Initialize Directory Layout
mkdir -p kratos-protocol && cd kratos-protocol
anchor init . --javascript false

# 2. Configure Solana CLI to Localnet
solana config set --url localhost

# 3. Generate Local Keypair (if not present)
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/id.json --force

# 4. Start Local Solana Validator in a separate terminal window:
solana-test-validator --reset --quiet