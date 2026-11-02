import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import { CONFIG } from "./config";

function getPayer(): Keypair {
  if (CONFIG.KEEPER_KEYPAIR_PATH && fs.existsSync(CONFIG.KEEPER_KEYPAIR_PATH)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(CONFIG.KEEPER_KEYPAIR_PATH, "utf-8"))));
  }
  return Keypair.generate();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  console.log(`Executing Aegis CLI Command: [${command || "HELP"}]`);

  const connection = new Connection(CONFIG.SOLANA_RPC_URL, "confirmed");
  const payer = getPayer();

  switch (command) {
    case "status": {
      const balance = await connection.getBalance(payer.publicKey);
      console.log(`Operator Account: ${payer.publicKey.toBase58()}`);
      console.log(`Balance:          ${balance / LAMPORTS_PER_SOL} SOL`);
      break;
    }
    case "inspect-escrow": {
      const escrowPkStr = args[1];
      if (!escrowPkStr) {
        console.error("Usage: npm run cli inspect-escrow <ESCROW_PUBKEY>");
        process.exit(1);
      }
      const accInfo = await connection.getAccountInfo(new PublicKey(escrowPkStr));
      if (!accInfo) {
        console.log("Escrow account not found or not yet initialized.");
      } else {
        console.log(`Account Data Length: ${accInfo.data.length} bytes`);
        console.log(`Vault Balance:       ${accInfo.lamports / LAMPORTS_PER_SOL} SOL`);
      }
      break;
    }
    default:
      console.log("AegisVault Automation CLI");
      console.log("Commands:");
      console.log("  status                            - Query current keeper wallet balance");
      console.log("  inspect-escrow <ESCROW_PUBKEY>    - Query raw state of target escrow");
      break;
  }
}

main().catch(console.error);