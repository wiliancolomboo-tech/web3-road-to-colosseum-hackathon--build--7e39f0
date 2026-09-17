# Create an environment file or pass arguments directly:
export RPC_URL="http://127.0.0.1:8899"
export KEEPER_KEYPAIR="$HOME/.config/solana/id.json"
export PROGRAM_ID=$(solana address -k target/deploy/kratos-keypair.json)

# Launch the Keeper Bot
npx ts-node keeper/crank.ts