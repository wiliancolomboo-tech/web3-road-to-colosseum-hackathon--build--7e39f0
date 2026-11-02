import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import dotenv from "dotenv";
import fs from "fs";
import { logger } from "./logger";
import { ResendNotificationService } from "./services/resendService";
import { WebhookService } from "./services/webhookService";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "StrmSentry111111111111111111111111111111111"
);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const WS_URL = process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com";

export class StreamSentryDaemon {
  private connection: Connection;
  private resendService: ResendNotificationService;
  private webhookService: WebhookService;
  private keeperKeypair: Keypair;
  private processedSignatures: Set<string>;

  constructor() {
    this.connection = new Connection(RPC_URL, {
      wsEndpoint: WS_URL,
      commitment: "confirmed",
    });
    this.resendService = new ResendNotificationService();
    this.webhookService = new WebhookService();
    this.processedSignatures = new Set<string>();

    const privateKeyRaw = process.env.KEEPER_PRIVATE_KEY;
    if (privateKeyRaw && fs.existsSync(privateKeyRaw)) {
      const secret = JSON.parse(fs.readFileSync(privateKeyRaw, "utf-8"));
      this.keeperKeypair = Keypair.fromSecretKey(new Uint8Array(secret));
    } else {
      this.keeperKeypair = Keypair.generate();
      logger.warn(`Generated ephemeral keeper keypair: ${this.keeperKeypair.publicKey.toBase58()}`);
    }
  }

  public async start(): Promise<void> {
    logger.info("Initializing StreamSentry Autonomous Keeper Daemon...");
    logger.info(`Target Program ID: ${PROGRAM_ID.toBase58()}`);
    logger.info(`Keeper Signer: ${this.keeperKeypair.publicKey.toBase58()}`);

    await this.webhookService.sendSecurityAlert(
      "Daemon Initialized",
      `StreamSentry daemon is now actively monitoring program ${PROGRAM_ID.toBase58()}`,
      "INFO"
    );

    // Subscribe to program logs via WebSocket
    this.connection.onLogs(
      PROGRAM_ID,
      async (logs, ctx) => {
        if (logs.err) return;
        const sig = logs.signature;
        if (this.processedSignatures.has(sig)) return;
        this.processedSignatures.add(sig);

        // Keep set size bounded
        if (this.processedSignatures.size > 10000) {
          this.processedSignatures.clear();
        }

        await this.handleLogEvent(logs.logs, sig, ctx.slot);
      },
      "confirmed"
    );

    // Schedule background periodic cron crank
    setInterval(async () => {
      await this.runAutonomousCrank();
    }, 30000); // Runs every 30 seconds
  }

  private async handleLogEvent(logs: string[], signature: string, slot: number): Promise<void> {
    for (const log of logs) {
      if (log.includes("StreamCreatedEvent")) {
        logger.info(`[Slot ${slot}] Detected StreamCreatedEvent in tx ${signature}`);
        await this.webhookService.sendSecurityAlert(
          "Stream Initialized",
          `A new escrow stream was created. Tx: ${signature}`,
          "INFO"
        );
      } else if (log.includes("StreamWithdrawnEvent")) {
        logger.info(`[Slot ${slot}] Detected StreamWithdrawnEvent in tx ${signature}`);
        await this.resendService.sendStreamDisbursementNotice(
          process.env.PAYROLL_RECIPIENT_EMAIL || "payee@example.com",
          "STREAM-AUTO",
          500000000
        );
      } else if (log.includes("StreamStatusChangedEvent")) {
        logger.warn(`[Slot ${slot}] Stream state changed / paused in tx ${signature}`);
        await this.webhookService.sendSecurityAlert(
          "Stream State Modified / Disputed",
          `Stream state was altered or entered dispute mode. Tx: ${signature}`,
          "CRITICAL"
        );
      }
    }
  }

  private async runAutonomousCrank(): Promise<void> {
    try {
      logger.info("Executing autonomous keeper sweep for streaming settlements...");
      // In production, fetch program accounts filter by status == Active
      // Check claimable balances and execute batch withdrawal CPI where configured.
    } catch (err: any) {
      logger.error(`Crank execution exception: ${err.message}`);
    }
  }
}

// Auto-start daemon if run directly
if (require.main === module) {
  const daemon = new StreamSentryDaemon();
  daemon.start().catch((err) => {
    logger.error(`Fatal crash in daemon: ${err.message}`);
    process.exit(1);
  });
}