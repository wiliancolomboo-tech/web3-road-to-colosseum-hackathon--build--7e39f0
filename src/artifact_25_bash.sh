# 1. Clone repository & install dependencies
git clone https://github.com/nexus-stream/nexus-stream-protocol.git
cd nexus-stream-protocol
npm install
cd cli && npm install && npm run build && cd ..

# 2. Build Anchor smart contract
anchor build

# 3. Synchronize program keys
anchor keys sync

# 4. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Execute End-to-End Test Suite
anchor test --skip-local-validator