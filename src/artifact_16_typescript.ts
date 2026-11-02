#!/usr/bin/env node
import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { AegisWorkerService } from "./agent-worker";
import fs from "fs";

const program = new Command();

program
  .name("aegisguard-cli")
  .description("Enterprise CLI for AegisGuard Autonomous Agent Coordination")
  .version("1.0.0");

program
  .command("listen")
  .description("Run autonomous agent listener worker")
  .requiredOption("-k, --keypair <path>", "Path to worker keypair JSON")
  .requiredOption("-p, --program-id <pubkey>", "AegisGuard Program ID")
  .option("-r, --rpc <url>", "Solana RPC URL", "http://127.0.0.1:8899")
  .action(async (options) => {
    const rawKey = JSON.parse(fs.readFileSync(options.keypair, "utf-8"));
    const workerKeypair = Keypair.fromSecretKey(new Uint8Array(rawKey));
    const programId = new PublicKey(options.programId);

    const workerService = new AegisWorkerService({
      rpcUrl: options.rpc,
      workerKeypair,
      programId,
      resendApiKey: process.env.RESEND_API_KEY,
      auditEmailRecipient: process.env.AUDIT_EMAIL,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    });

    console.log(`[AEGIS DAEMON] Active. Listening for tasks. Worker Pubkey: ${workerKeypair.publicKey.toBase58()}`);
    await workerService.notifyDiscord("AegisGuard Worker Online", [
      { name: "Node Status", value: "LISTENING" },
      { name: "Public Key", value: workerKeypair.publicKey.toBase58() }
    ], 0x3b82f6);
  });

program.parse(process.argv);