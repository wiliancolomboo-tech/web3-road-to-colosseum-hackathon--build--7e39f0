import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import crypto from "crypto";
import axios from "axios";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

export interface WorkerConfig {
  rpcUrl: string;
  workerKeypair: Keypair;
  programId: PublicKey;
  resendApiKey?: string;
  auditEmailRecipient?: string;
  discordWebhookUrl?: string;
}

export class AegisWorkerService {
  private connection: Connection;
  private worker: Keypair;
  private programId: PublicKey;
  private resend?: Resend;
  private discordWebhook?: string;
  private auditEmail?: string;

  constructor(config: WorkerConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.worker = config.workerKeypair;
    this.programId = config.programId;
    this.discordWebhook = config.discordWebhookUrl;
    this.auditEmail = config.auditEmailRecipient;
    if (config.resendApiKey) {
      this.resend = new Resend(config.resendApiKey);
    }
  }

  public deriveEscrowPda(delegator: PublicKey, taskId: anchor.BN): [PublicKey, number] {
    const taskIdBuffer = taskId.toArrayLike(Buffer, "le", 8);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), delegator.toBuffer(), taskIdBuffer],
      this.programId
    );
  }

  public deriveVaultPda(escrowPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      this.programId
    );
  }

  /**
   * Dispatches high-priority telemetry to Discord Enterprise webhook.
   */
  public async notifyDiscord(title: string, fields: { name: string; value: string }[], color: number = 0x22c55e): Promise<void> {
    if (!this.discordWebhook) return;
    try {
      await axios.post(this.discordWebhook, {
        embeds: [
          {
            title: `🛡️ AegisGuard Alert: ${title}`,
            color,
            fields,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err: any) {
      console.error("[TELEMETRY WARNING] Failed to send Discord webhook:", err.message);
    }
  }

  /**
   * Dispatches formal audit receipt via Resend Email API.
   */
  public async sendAuditReceipt(taskId: string, amount: string, recipient: string, txSignature: string): Promise<void> {
    if (!this.resend || !this.auditEmail) return;
    try {
      await this.resend.emails.send({
        from: "notifications@resend.dev",
        to: this.auditEmail,
        subject: `[AegisGuard Audit] Task #${taskId} Settled On-Chain`,
        html: `
          <h2>AegisGuard Autonomous Settlement Receipt</h2>
          <p><strong>Task ID:</strong> ${taskId}</p>
          <p><strong>Settlement Amount:</strong> ${amount} base units</p>
          <p><strong>Worker Node:</strong> ${recipient}</p>
          <p><strong>Solana Tx Signature:</strong> <a href="https://solscan.io/tx/${txSignature}?cluster=custom">${txSignature}</a></p>
          <p><em>Verified via SVM PDA State Commitment</em></p>
        `,
      });
      console.log(`[RESEND] Audit email dispatched to ${this.auditEmail}`);
    } catch (err: any) {
      console.error("[AUDIT WARNING] Failed to send Resend email:", err.message);
    }
  }

  /**
   * Executes AI Compute & Dispatches on-chain fulfillment
   */
  public async processAndFulfillTask(
    program: Program,
    delegator: PublicKey,
    taskId: anchor.BN,
    mint: PublicKey,
    computePayload: string
  ): Promise<string> {
    console.log(`[WORKER] Initiating execution for Task #${taskId.toString()}...`);

    // 1. Off-chain deterministic execution & hashing
    const resultHash = crypto.createHash("sha256").update(computePayload).digest();
    const resultHashArray = Array.from(new Uint8Array(resultHash));

    const [escrowPda] = this.deriveEscrowPda(delegator, taskId);
    const [vaultPda] = this.deriveVaultPda(escrowPda);
    const workerTokenAccount = getAssociatedTokenAddressSync(mint, this.worker.publicKey);

    // 2. Transmit on-chain settlement transaction
    const tx = await (program.methods as any)
      .fulfillTask(resultHashArray)
      .accounts({
        worker: this.worker.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        workerTokenAccount: workerTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.worker])
      .rpc();

    console.log(`[WORKER] Task #${taskId.toString()} successfully fulfilled on-chain. Tx: ${tx}`);

    // 3. Enterprise Event Notification Pipeline
    await this.notifyDiscord("Task Fulfilled & Escrow Disbursed", [
      { name: "Task ID", value: taskId.toString() },
      { name: "Worker", value: this.worker.publicKey.toBase58() },
      { name: "Transaction", value: tx },
    ]);

    await this.sendAuditReceipt(taskId.toString(), "Escrow Paid", this.worker.publicKey.toBase58(), tx);

    return tx;
  }
}