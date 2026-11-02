import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, BorshCoder, EventParser } from "@coral-xyz/anchor";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "Aegis11111111111111111111111111111111111111");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ENTERPRISE_NOTIFICATION_EMAIL = process.env.ENTERPRISE_NOTIFICATION_EMAIL || "treasury@enterprise.org";

// Minimal IDL Definition for the Events
const IDL_JSON: Idl = {
  version: "0.1.0",
  name: "aegis_flow",
  instructions: [],
  events: [
    {
      name: "EscrowInitializedEvent",
      fields: [
        { name: "escrow", type: "publicKey", index: false },
        { name: "payer", type: "publicKey", index: false },
        { name: "recipient", type: "publicKey", index: false },
        { name: "totalAmount", type: "u64", index: false },
        { name: "totalMilestones", type: "u8", index: false },
        { name: "timelockDeadline", type: "i64", index: false }
      ]
    },
    {
      name: "MilestoneSubmittedEvent",
      fields: [
        { name: "escrow", type: "publicKey", index: false },
        { name: "milestoneIndex", type: "u8", index: false },
        { name: "deliverableHash", type: { array: ["u8", 32] }, index: false }
      ]
    },
    {
      name: "MilestoneApprovedEvent",
      fields: [
        { name: "escrow", type: "publicKey", index: false },
        { name: "milestoneIndex", type: "u8", index: false },
        { name: "amountReleased", type: "u64", index: false },
        { name: "remainingBalance", type: "u64", index: false }
      ]
    },
    {
      name: "EscrowCancelledEvent",
      fields: [
        { name: "escrow", type: "publicKey", index: false },
        { name: "refundAmount", type: "u64", index: false }
      ]
    }
  ]
};

class NotificationService {
  public static async dispatchDiscord(title: string, description: string, fields: Array<{ name: string; value: string; inline?: boolean }>) {
    if (!DISCORD_WEBHOOK_URL) {
      console.log(`[NotificationService] No Discord Webhook configured. Skipping Discord alert.`);
      return;
    }

    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: `🛡️ AegisFlow: ${title}`,
            description,
            fields,
            color: 0x22c55e,
            timestamp: new Date().toISOString(),
          }
        ]
      });
      console.log(`[NotificationService] Discord dispatch sent.`);
    } catch (err: any) {
      console.error(`[NotificationService] Discord dispatch failed:`, err.message);
    }
  }

  public static async dispatchEmailAudit(subject: string, htmlContent: string) {
    if (!RESEND_API_KEY) {
      console.log(`[NotificationService] No Resend API Key configured. Skipping Email dispatch.`);
      return;
    }

    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "AegisFlow Engine <notifications@aegisflow.io>",
          to: [ENTERPRISE_NOTIFICATION_EMAIL],
          subject: `[AegisFlow Settlement Audit] ${subject}`,
          html: htmlContent
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
      console.log(`[NotificationService] Resend email audit dispatched.`);
    } catch (err: any) {
      console.error(`[NotificationService] Resend email dispatch failed:`, err.message);
    }
  }
}

export class AegisWatcher {
  private connection: Connection;
  private coder: BorshCoder;
  private eventParser: EventParser;

  constructor() {
    this.connection = new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: RPC_URL.replace("https", "wss") });
    this.coder = new BorshCoder(IDL_JSON);
    this.eventParser = new EventParser(PROGRAM_ID, this.coder);
  }

  public async start(): Promise<void> {
    console.log(`[AegisWatcher] Initializing event listener for program: ${PROGRAM_ID.toBase58()} on ${RPC_URL}`);

    this.connection.onLogs(
      PROGRAM_ID,
      async (logs) => {
        if (logs.err) return;

        const events = this.eventParser.parseLogs(logs.logs);
        for (const event of events) {
          await this.handleEvent(event);
        }
      },
      "confirmed"
    );

    console.log(`[AegisWatcher] Active. Listening for real-time Solana instructions...`);
  }

  private async handleEvent(event: any) {
    console.log(`[AegisWatcher] Received on-chain event: ${event.name}`);

    switch (event.name) {
      case "EscrowInitializedEvent": {
        const { escrow, payer, recipient, totalAmount, totalMilestones, timelockDeadline } = event.data;
        await NotificationService.dispatchDiscord("New Escrow Contract Initialized", `Escrow deployed: \`${escrow.toString()}\``, [
          { name: "Payer", value: payer.toString(), inline: true },
          { name: "Recipient", value: recipient.toString(), inline: true },
          { name: "Total Amount", value: totalAmount.toString(), inline: true },
          { name: "Milestones", value: totalMilestones.toString(), inline: true },
          { name: "Timelock Deadline", value: new Date(Number(timelockDeadline) * 1000).toUTCString() }
        ]);
        break;
      }

      case "MilestoneSubmittedEvent": {
        const { escrow, milestoneIndex, deliverableHash } = event.data;
        const hexHash = Buffer.from(deliverableHash).toString("hex");

        await NotificationService.dispatchDiscord("Milestone Proof Submitted", `Recipient has submitted deliverables for escrow: \`${escrow.toString()}\``, [
          { name: "Milestone Index", value: milestoneIndex.toString(), inline: true },
          { name: "Deliverable SHA-256", value: `\`${hexHash}\`` }
        ]);

        await NotificationService.dispatchEmailAudit(
          `Milestone #${milestoneIndex} Submitted for Escrow ${escrow.toString()}`,
          `<h3>Milestone Action Required</h3>
           <p>Deliverables have been submitted for Escrow <code>${escrow.toString()}</code>.</p>
           <p><strong>Deliverable Proof Hash:</strong> <code>${hexHash}</code></p>
           <p>Review the artifacts and approve on-chain to trigger token release.</p>`
        );
        break;
      }

      case "MilestoneApprovedEvent": {
        const { escrow, milestoneIndex, amountReleased, remainingBalance } = event.data;
        await NotificationService.dispatchDiscord("Milestone Payment Released", `Payer approved milestone #${milestoneIndex} on \`${escrow.toString()}\``, [
          { name: "Milestone Index", value: milestoneIndex.toString(), inline: true },
          { name: "Amount Released", value: amountReleased.toString(), inline: true },
          { name: "Remaining Vault Balance", value: remainingBalance.toString(), inline: true }
        ]);
        break;
      }

      case "EscrowCancelledEvent": {
        const { escrow, refundAmount } = event.data;
        await NotificationService.dispatchDiscord("Escrow Timelock Refund Triggered", `Escrow \`${escrow.toString()}\` has been refunded due to timelock expiration.`, [
          { name: "Refunded Capital", value: refundAmount.toString(), inline: true }
        ]);
        break;
      }
    }
  }
}

if (require.main === module) {
  const watcher = new AegisWatcher();
  watcher.start().catch((err) => {
    console.error("Fatal exception in AegisWatcher:", err);
    process.exit(1);
  });
}