# In the project root directory:
# Copy programs/kratos/src/lib.rs into the program file

# Build the binary to generate IDL and program keypair
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Rebuild with matching keys
anchor build

# Deploy to Localnet
anchor deploy