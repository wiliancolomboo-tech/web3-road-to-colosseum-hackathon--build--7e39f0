import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import axios from "axios";
import * as crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const KEEPER_KEYPAIR_RAW = process.env.KEEPER_PRIVATE_KEY || "[]";
const PROGRAM_ID = new web3.PublicKey(
  process.env.PROGRAM_ID || "Chrno7Yq91R3KzUeN9r62v9eYtYFw5e8qM3v8b2b7jKL"
);
const WEBHOOK_URL = process.env.ENTERPRISE_WEBHOOK_URL || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "chronolock-enterprise-secret-key-32b";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const AUDIT_EMAIL_TO = process.env.AUDIT_EMAIL_TO || "treasury@enterprise-partner.xyz";

// Minimal IDL Definition
const IDL: anchor.Idl = {
  version: "0.1.0",
  name: "chrono_lock",
  instructions: [
    {
      name: "keeperAutoRelease",
      accounts: [
        { name: "keeper", isMut: true, isSigner: true },
        { name: "beneficiary", isMut: true, isSigner: false },
        { name: "escrowState", isMut: true, isSigner: false },
        { name: "vault", isMut: true, isSigner: false },
      ],
      args: [],
    },
  ],
  events: [
    {
      name: "MilestoneSubmittedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "milestoneIndex", type: "u8", index: false },
        { name: "deliverableHash", type: { array: ["u8", 32] }, index: false },
        { name: "submittedAt", type: "i64", index: false },
      ],
    },
    {
      name: "MilestoneAutoReleasedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "milestoneIndex", type: "u8", index: false },
        { name: "amountReleased", type: "u64", index: false },
        { name: "keeper", type: "publicKey", index: false },
        { name: "timestamp", type: "i64", index: false },
      ],
    },
  ],
  errors: [],
};

// Cryptographic Webhook Dispatcher
async function sendEnterpriseNotification(event: string, payload: Record<string, unknown>): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ event, payload, timestamp });
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  if (WEBHOOK_URL) {
    try {
      await axios.post(WEBHOOK_URL, body, {
        headers: {
          "Content-Type": "application/json",
          "X-ChronoLock-Signature": signature,
          "X-ChronoLock-Timestamp": timestamp,
        },
        timeout: 5000,
      });
      console.log(`[Webhook] Dispatched ${event} successfully.`);
    } catch (err: unknown) {
      console.error(`[Webhook] Failed to dispatch ${event}:`, (err as Error).message);
    }
  }

  if (RESEND_API_KEY) {
    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "ChronoLock Protocol <notifications@chronolock.io>",
          to: [AUDIT_EMAIL_TO],
          subject: `[Audit Alert] ChronoLock State Update: ${event}`,
          html: `<p>A new ChronoLock on-chain event occurred.</p><pre>${JSON.stringify(
            payload,
            null,
            2
          )}</pre>`,
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        }
      );
      console.log(`[Resend] Audit email delivered for ${event}.`);
    } catch (err: unknown) {
      console.error(`[Resend] Failed to send email alert:`, (err as Error).message);
    }
  }
}

// Keeper Service Execution Loop
async function runKeeperDaemon(): Promise<void> {
  console.log("=================================================");
  console.log("       CHRONOLOCK AUTONOMOUS KEEPER WORKER       ");
  console.log("=================================================");

  const connection = new web3.Connection(RPC_ENDPOINT, "confirmed");
  let keeperKeypair: web3.Keypair;

  try {
    const rawKey = JSON.parse(KEEPER_KEYPAIR_RAW);
    keeperKeypair = web3.Keypair.fromSecretKey(Uint8Array.from(rawKey));
  } catch {
    console.warn("[Warning] Invalid or missing KEEPER_PRIVATE_KEY. Generating ephemeral keypair.");
    keeperKeypair = web3.Keypair.generate();
  }

  const wallet = new anchor.Wallet(keeperKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program(IDL, PROGRAM_ID, provider);

  console.log(`Keeper Address: ${keeperKeypair.publicKey.toBase58()}`);
  console.log(`Target Program: ${PROGRAM_ID.toBase58()}`);

  const pollIntervalMs = 15000;

  setInterval(async () => {
    try {
      // Fetch all program accounts for EscrowState
      const accounts = await connection.getProgramAccounts(PROGRAM_ID);
      const currentTime = Math.floor(Date.now() / 1000);

      for (const rawAcc of accounts) {
        // Minimum size check (must equal or exceed basic escrow fields)
        if (rawAcc.account.data.length < 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 8 + 1 + 8 + 8 + 1 + 1) {
          continue;
        }

        const data = rawAcc.account.data.subarray(8); // strip 8-byte discriminator
        const sponsor = new web3.PublicKey(data.subarray(0, 32));
        const beneficiary = new web3.PublicKey(data.subarray(32, 64));
        const escrowId = new BN(data.subarray(64, 72), "le");
        const remainingBalance = new BN(data.subarray(80, 88), "le");
        const currentMilestone = data[89];
        const disputeWindow = new BN(data.subarray(90, 98), "le").toNumber();
        const stateTag = data[98]; // 0: Active, 1: Completed, 2: Disputed, 3: Cancelled
        const lastSubmissionTime = new BN(data.subarray(107, 115), "le").toNumber();

        // Check if Active, submitted, and dispute window has expired
        if (stateTag === 0 && lastSubmissionTime > 0 && remainingBalance.gt(new BN(0))) {
          const eligibleReleaseTime = lastSubmissionTime + disputeWindow;

          if (currentTime >= eligibleReleaseTime) {
            console.log(`[Auto-Release Trigger] Escrow ID ${escrowId.toString()} milestone ${currentMilestone} eligible.`);

            const [escrowPDA] = web3.PublicKey.findProgramAddressSync(
              [Buffer.from("escrow"), sponsor.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
              PROGRAM_ID
            );
            const [vaultPDA] = web3.PublicKey.findProgramAddressSync(
              [Buffer.from("vault"), sponsor.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
              PROGRAM_ID
            );

            try {
              const tx = await program.methods
                .keeperAutoRelease()
                .accounts({
                  keeper: keeperKeypair.publicKey,
                  beneficiary,
                  escrowState: escrowPDA,
                  vault: vaultPDA,
                })
                .rpc();

              console.log(`[Success] Auto-released escrow ${escrowId.toString()} | Tx: ${tx}`);

              await sendEnterpriseNotification("MILESTONE_AUTO_RELEASED", {
                escrowId: escrowId.toString(),
                milestoneIndex: currentMilestone,
                beneficiary: beneficiary.toBase58(),
                transactionSignature: tx,
                releasedAt: currentTime,
              });
            } catch (err: unknown) {
              console.error(`[Error] Execution failed for escrow ${escrowId.toString()}:`, (err as Error).message);
            }
          }
        }
      }
    } catch (loopErr: unknown) {
      console.error("[Daemon Polling Error]", (loopErr as Error).message);
    }
  }, pollIntervalMs);
}

runKeeperDaemon().catch((err) => {
  console.error("[Fatal Error]", err);
  process.exit(1);
});