npx ts-node -e '
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Vortex;
  
  console.log("Deploying Vortex Market on Devnet for program:", program.programId.toBase58());
}
main();
'