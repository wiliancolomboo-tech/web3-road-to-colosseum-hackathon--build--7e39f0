import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";
import * as crypto from "crypto";

// Configuration Schema
interface TelemetryConfig {
    discordWebhookUrl?: string;
    slackWebhookUrl?: string;
    resendApiKey?: string;
    alertEmailRecipient?: string;
}

export class AetherOrchestrator {
    private connection: Connection;
    private wallet: anchor.Wallet;
    private programId: PublicKey;
    private telemetryConfig: TelemetryConfig;

    constructor(
        rpcUrl: string,
        keypair: Keypair,
        programIdStr: string,
        telemetryConfig: TelemetryConfig
    ) {
        this.connection = new Connection(rpcUrl, "confirmed");
        this.wallet = new anchor.Wallet(keypair);
        this.programId = new PublicKey(programIdStr);
        this.telemetryConfig = telemetryConfig;
    }

    public async dispatchEnterpriseAlert(level: "INFO" | "WARN" | "CRITICAL", title: string, metadata: Record<string, any>) {
        const timestamp = new Date().toISOString();
        const payloadText = `[${level}] ${title}\n` + Object.entries(metadata).map(([k, v]) => `• ${k}: ${v}`).join("\n");

        console.log(`\x1b[36m[AetherTelemetry] Dispatched: ${title}\x1b[0m`);

        // 1. Dispatch to Discord Webhook
        if (this.telemetryConfig.discordWebhookUrl) {
            try {
                await axios.post(this.telemetryConfig.discordWebhookUrl, {
                    embeds: [{
                        title: `${level === "CRITICAL" ? "🚨 " : "🛡️ "} ${title}`,
                        color: level === "CRITICAL" ? 0xff0000 : level === "WARN" ? 0xffaa00 : 0x00ff88,
                        fields: Object.entries(metadata).map(([name, value]) => ({
                            name,
                            value: String(value),
                            inline: true,
                        })),
                        footer: { text: "AetherVault Solana Enterprise Telemetry" },
                        timestamp,
                    }]
                });
            } catch (err: any) {
                console.error("Failed to forward telemetry to Discord:", err.message);
            }
        }

        // 2. Dispatch to Enterprise Slack Ops
        if (this.telemetryConfig.slackWebhookUrl) {
            try {
                await axios.post(this.telemetryConfig.slackWebhookUrl, {
                    text: `*${title}* (${level})\n\`\`\`${JSON.stringify(metadata, null, 2)}\`\`\``
                });
            } catch (err: any) {
                console.error("Failed to forward telemetry to Slack:", err.message);
            }
        }

        // 3. Dispatch to Resend Mailer API on CRITICAL breaches
        if (level === "CRITICAL" && this.telemetryConfig.resendApiKey && this.telemetryConfig.alertEmailRecipient) {
            try {
                await axios.post(
                    "https://api.resend.com/emails",
                    {
                        from: "security@aethervault.io",
                        to: this.telemetryConfig.alertEmailRecipient,
                        subject: `CRITICAL: Solana Circuit Breaker Triggered - ${title}`,
                        text: payloadText,
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${this.telemetryConfig.resendApiKey}`,
                            "Content-Type": "application/json",
                        }
                    }
                );
            } catch (err: any) {
                console.error("Failed to send Resend email alert:", err.message);
            }
        }
    }

    public deriveCircuitBreakerPDA(authority: PublicKey): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("circuit_breaker"), authority.toBuffer()],
            this.programId
        );
    }

    public deriveEscrowPDA(buyer: PublicKey, escrowId: anchor.BN): [PublicKey, number] {
        return PublicKey.findProgramAddressSync(
            [Buffer.from("escrow"), buyer.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
            this.programId
        );
    }

    public async listenToOnChainEvents(program: Program<any>) {
        console.log(`Subscribing to AetherVault events on program: ${this.programId.toBase58()}`);

        program.addEventListener("CircuitBreakerInitializedEvent", (event, slot) => {
            this.dispatchEnterpriseAlert("INFO", "Circuit Breaker Initialized", {
                authority: event.authority.toBase58(),
                maxEpochOutflow: `${event.maxEpochOutflow.toNumber() / LAMPORTS_PER_SOL} SOL`,
                duration: `${event.epochDurationSeconds}s`,
                slot,
            });
        });

        program.addEventListener("EscrowCreatedEvent", (event, slot) => {
            this.dispatchEnterpriseAlert("INFO", "New Escrow Created", {
                escrowId: event.escrowId.toString(),
                buyer: event.buyer.toBase58(),
                recipient: event.recipient.toBase58(),
                amount: `${event.amount.toNumber() / LAMPORTS_PER_SOL} SOL`,
                slot,
            });
        });

        program.addEventListener("EscrowCompletedEvent", (event, slot) => {
            this.dispatchEnterpriseAlert("INFO", "Escrow Succeeded & Released", {
                escrowId: event.escrowId.toString(),
                recipient: event.recipient.toBase58(),
                amount: `${event.amount.toNumber() / LAMPORTS_PER_SOL} SOL`,
                slot,
            });
        });

        program.addEventListener("CircuitBreakerStatusUpdatedEvent", (event, slot) => {
            const level = event.isFrozen ? "CRITICAL" : "WARN";
            this.dispatchEnterpriseAlert(level, `Circuit Breaker ${event.isFrozen ? "FROZEN" : "UNFROZEN"}`, {
                authority: event.authority.toBase58(),
                isFrozen: event.isFrozen,
                slot,
            });
        });
    }

    public static hashDeliverable(data: string): Buffer {
        return crypto.createHash("sha256").update(data).digest();
    }
}

// -----------------------------------------------------------------------------
// EXECUTABLE CLI ENTRYPOINT
// -----------------------------------------------------------------------------
async function run() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const secretKeyEnv = process.env.OPERATOR_PRIVATE_KEY;
    const programId = process.env.PROGRAM_ID || "AethrV1111111111111111111111111111111111111";

    let keypair: Keypair;
    if (secretKeyEnv) {
        keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyEnv)));
    } else {
        keypair = Keypair.generate();
        console.log(`Generated ephemeral operator keypair: ${keypair.publicKey.toBase58()}`);
    }

    const orchestrator = new AetherOrchestrator(rpcUrl, keypair, programId, {
        discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
        slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
        resendApiKey: process.env.RESEND_API_KEY,
        alertEmailRecipient: process.env.ALERT_EMAIL_RECIPIENT,
    });

    await orchestrator.dispatchEnterpriseAlert("INFO", "AetherVault Telemetry Daemon Online", {
        operator: keypair.publicKey.toBase58(),
        cluster: rpcUrl,
        engineVersion: "v1.0.0-prod",
    });
}

if (require.main === module) {
    run().catch(console.error);
}