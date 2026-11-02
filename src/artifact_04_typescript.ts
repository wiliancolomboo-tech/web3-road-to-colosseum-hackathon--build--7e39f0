import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration Interface
interface AegisConfig {
  rpcUrl: string;
  keeperKeypair: Keypair;
  programId: PublicKey;
  vaultPubkey: PublicKey;
  slackWebhookUrl?: string;
  resendApiKey?: string;
  alertEmailRecipient?: string;
  pollIntervalMs: number;
}

export class AegisKeeperDaemon {
  private connection: Connection;
  private keeper: Keypair;
  private programId: PublicKey;
  private vaultPubkey: PublicKey;
  private slackWebhookUrl?: string;
  private resendApiKey?: string;
  private alertEmailRecipient?: string;
  private pollIntervalMs: number;
  private isProcessing = false;

  constructor(config: AegisConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.keeper = config.keeperKeypair;
    this.programId = config.programId;
    this.vaultPubkey = config.vaultPubkey;
    this.slackWebhookUrl = config.slackWebhookUrl;
    this.resendApiKey = config.resendApiKey;
    this.alertEmailRecipient = config.alertEmailRecipient;
    this.pollIntervalMs = config.pollIntervalMs;
  }

  public async start(): Promise<void> {
    console.log(`[Aegis-Keeper] Starting Autonomous Agent for Vault: ${this.vaultPubkey.toBase58()}`);
    console.log(`[Aegis-Keeper] Keeper Identity: ${this.keeper.publicKey.toBase58()}`);

    setInterval(async () => {
      if (this.isProcessing) return;
      try {
        this.isProcessing = true;
        await this.evaluateAndExecute();
      } catch (err: any) {
        console.error(`[Aegis-Keeper] Loop error:`, err?.message || err);
      } finally {
        this.isProcessing = false;
      }
    }, this.pollIntervalMs);
  }

  private async evaluateAndExecute(): Promise<void> {
    const currentSlot = await this.connection.getSlot("processed");
    
    // Fetch on-chain vault data
    const vaultInfo = await this.connection.getAccountInfo(this.vaultPubkey);
    if (!vaultInfo) {
      console.warn(`[Aegis-Keeper] Vault account ${this.vaultPubkey.toBase58()} not found.`);
      return;
    }

    // Derive Session PDA
    const [sessionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_session"), this.vaultPubkey.toBuffer(), this.keeper.publicKey.toBuffer()],
      this.programId
    );

    const sessionInfo = await this.connection.getAccountInfo(sessionPda);
    if (!sessionInfo) {
      console.warn(`[Aegis-Keeper] No active session PDA found for keeper.`);
      return;
    }

    // Telemetry: Simulate real-world liquidation health check from oracle or target protocol
    const simulatedCurrentHealthBps = await this.fetchSimulatedCollateralHealth();
    const thresholdBps = 1500; // 15.00% minimum health buffer

    console.log(`[Slot ${currentSlot}] Collateral Health: ${simulatedCurrentHealthBps / 100}% | Threshold: ${thresholdBps / 100}%`);

    if (simulatedCurrentHealthBps <= thresholdBps) {
      console.warn(`[DEFENSE TRIGGER] Liquidation risk detected! Health: ${simulatedCurrentHealthBps / 100}%`);
      const executionAmount = 50_000_000; // 50 USDC (6 decimals) or appropriate SPL buffer
      await this.triggerDefenseTransaction(sessionPda, executionAmount, simulatedCurrentHealthBps);
    }
  }

  private async fetchSimulatedCollateralHealth(): Promise<number> {
    // In production, queries Marginfi / Kamino / Pyth oracle directly.
    // For demo/agent MVP, we evaluate mock health or live pool reserves.
    return 1250; // 12.50% (trigger active)
  }

  private async triggerDefenseTransaction(
    sessionPda: PublicKey,
    amount: number,
    observedHealthBps: number
  ): Promise<void> {
    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_reserve"), this.vaultPubkey.toBuffer()],
      this.programId
    );

    // Read Vault state to resolve target collateral account
    // Fixed layout parsing for targetCollateral (bytes 96..128)
    const vaultAccount = await this.connection.getAccountInfo(this.vaultPubkey);
    if (!vaultAccount) throw new Error("Vault not found");

    const targetCollateralPubkey = new PublicKey(vaultAccount.data.subarray(96, 128));

    // Construct Anchor instruction discriminator for "execute_defense"
    // sha256("global:execute_defense")[0..8]
    const sighash = Buffer.from([206, 73, 203, 108, 129, 137, 240, 242]);
    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(BigInt(amount));
    const healthBuffer = Buffer.alloc(2);
    healthBuffer.writeUInt16LE(observedHealthBps);

    const instructionData = Buffer.concat([sighash, amountBuffer, healthBuffer]);

    const keys = [
      { pubkey: this.vaultPubkey, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: reservePda, isSigner: false, isWritable: true },
      { pubkey: targetCollateralPubkey, isSigner: false, isWritable: true },
      { pubkey: this.keeper.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    const instruction = new anchor.web3.TransactionInstruction({
      programId: this.programId,
      keys,
      data: instructionData,
    });

    const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
    const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 });

    const tx = new Transaction().add(priorityFeeIx, computeLimitIx, instruction);
    tx.feePayer = this.keeper.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;

    console.log(`[Aegis-Keeper] Broadcasting Defend Transaction...`);
    const txSignature = await sendAndConfirmTransaction(this.connection, tx, [this.keeper]);
    console.log(`[Aegis-Keeper] Transaction confirmed! Signature: ${txSignature}`);

    // Enterprise notification dispatch
    await this.notifySlack(txSignature, amount, observedHealthBps);
    await this.notifyResend(txSignature, amount, observedHealthBps);
  }

  private async notifySlack(signature: string, amount: number, healthBps: number): Promise<void> {
    if (!this.slackWebhookUrl) return;

    const payload = {
      text: `🚨 *[AegisStream] Liquidation Defense Executed!*`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "🛡️ Liquidation Defense Intervened" },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Vault:*\n\`${this.vaultPubkey.toBase58()}\`` },
            { type: "mrkdwn", text: `*Trigger Health:*\n${healthBps / 100}%` },
            { type: "mrkdwn", text: `*Top-Up Amount:*\n${(amount / 1e6).toFixed(2)} SPL` },
            { type: "mrkdwn", text: `*Tx Hash:*\n<https://solscan.io/tx/${signature}?cluster=devnet|View on Solscan>` },
          ],
        },
      ],
    };

    try {
      await axios.post(this.slackWebhookUrl, payload);
      console.log(`[Aegis-Keeper] Slack incident alert dispatched successfully.`);
    } catch (err: any) {
      console.error(`[Aegis-Keeper] Failed to dispatch Slack notification:`, err?.message);
    }
  }

  private async notifyResend(signature: string, amount: number, healthBps: number): Promise<void> {
    if (!this.resendApiKey || !this.alertEmailRecipient) return;

    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "Aegis Protocol <alerts@resend.dev>",
          to: [this.alertEmailRecipient],
          subject: `[CRITICAL ACTION] Collateral Replenished - Vault ${this.vaultPubkey.toBase58().slice(0, 8)}...`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0b0f19; color: #ffffff; padding: 24px; border-radius: 8px;">
              <h2 style="color: #10b981; margin-top: 0;">🛡️ AegisStream Defense Triggered</h2>
              <p>Your institutional treasury experienced a severe margin degradation below the designated threshold.</p>
              <hr style="border: 1px solid #1f2937;" />
              <p><strong>Observed Health Factor:</strong> ${healthBps / 100}%</p>
              <p><strong>Defensive Injection:</strong> ${(amount / 1e6).toFixed(2)} units</p>
              <p><strong>Transaction Signature:</strong> <a style="color: #38bdf8;" href="https://solscan.io/tx/${signature}?cluster=devnet">${signature}</a></p>
              <p style="font-size: 12px; color: #9ca3af;">Secured by Scoped Delegation Session Keys on Solana.</p>
            </div>
          `,
        },
        {
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[Aegis-Keeper] Resend executive email alert dispatched to ${this.alertEmailRecipient}.`);
    } catch (err: any) {
      console.error(`[Aegis-Keeper] Failed to dispatch Resend email:`, err?.response?.data || err?.message);
    }
  }
}

// Direct Execution Entrypoint
if (require.main === module) {
  const secretKey = process.env.KEEPER_PRIVATE_KEY
    ? Uint8Array.from(JSON.parse(process.env.KEEPER_PRIVATE_KEY))
    : Keypair.generate().secretKey;

  const config: AegisConfig = {
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    keeperKeypair: Keypair.fromSecretKey(secretKey),
    programId: new PublicKey(process.env.PROGRAM_ID || "Aegis111111111111111111111111111111111111111"),
    vaultPubkey: new PublicKey(process.env.VAULT_PUBKEY || Keypair.generate().publicKey.toBase58()),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    resendApiKey: process.env.RESEND_API_KEY,
    alertEmailRecipient: process.env.ALERT_EMAIL,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  };

  const daemon = new AegisKeeperDaemon(config);
  daemon.start().catch(console.error);
}