# ========================================================
# 1. BUILD & DEPLOY THE ON-CHAIN PROGRAM
# ========================================================
# Clean and compile Anchor program
anchor build

# Deploy to Solana Devnet / Mainnet-Beta
solana program deploy target/deploy/aegis_core.so \
  --program-id target/deploy/aegis_core-keypair.json \
  --url https://api.devnet.solana.com

# ========================================================
# 2. RUN FULL AUTOMATED TEST MATRIX
# ========================================================
anchor test

# ========================================================
# 3. INITIALIZE DAEMON ENVIRONMENT SECRETS
# ========================================================
mkdir -p secrets
solana-keygen new --no-bip39-passphrase -o secrets/keeper.json

cat <<EOF > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=Aegis11111111111111111111111111111111111111
TREASURY_CONFIG_PDA=<OUTPUT_TREASURY_PDA>
SLACK_WEBHOOK_URL=https://api.example.com/webhooks/alerts/placeholder
RESEND_API_KEY=re_123456789abcdef
INCIDENT_EMAIL_RECIPIENT=dev-ops-incidents@enterprise.xyz
CHECK_INTERVAL_MS=1500
EOF

# ========================================================
# 4. START 24/7 AUTONOMOUS ENTERPRISE KEEPER
# ========================================================
docker-compose up -d --build
docker-compose logs -f aegis-sentinel