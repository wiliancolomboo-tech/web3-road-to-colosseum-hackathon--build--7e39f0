import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Kratos } from "../target/types/kratos";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";

export class KratosCrankDaemon {
  private program: Program<Kratos>;
  private keeperKeypair: Keypair;
  private connection: Connection;
  private isProcessing: boolean = false;

  constructor(rpcUrl: string, keypairPath: string, programId: string) {
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
    const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    this.keeperKeypair = Keypair.fromSecretKey(new Uint8Array(secret));
    
    const wallet = new anchor.Wallet(this.keeperKeypair);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new Program<Kratos>(
      JSON.parse(fs.readFileSync("./target/idl/kratos.json", "utf8")),
      new PublicKey(programId),
      provider
    );
  }

  public async startLoop(pollIntervalMs: number = 3000) {
    console.log(`[KRATOS KEEPER] Crank Daemon initialized. Address: ${this.keeperKeypair.publicKey.toBase58()}`);
    setInterval(async () => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      try {
        await this.scanAndExecuteOrders();
      } catch (err) {
        console.error("[CRITICAL ERROR IN CRANK RUN]", err);
      } finally {
        this.isProcessing = false;
      }
    }, pollIntervalMs);
  }

  private async scanAndExecuteOrders() {
    const orders = await this.program.account.orderState.all();
    const now = Math.floor(Date.now() / 1000);

    for (const orderRecord of orders) {
      const order = orderRecord.account;
      const orderPubkey = orderRecord.publicKey;

      if (order.remainingDeposit.eqn(0)) continue;

      const nextEligibleTime = order.lastExecutionTimestamp.toNumber() + order.intervalSeconds.toNumber();
      if (now < nextEligibleTime) continue;

      console.log(`[TRIGGER IDENTIFIED] Order: ${orderPubkey.toBase58()} is eligible.`);
      await this.dispatchExecution(orderPubkey, order);
    }
  }

  private async dispatchExecution(orderPubkey: PublicKey, order: any) {
    try {
      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        this.program.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), orderPubkey.toBuffer()],
        this.program.programId
      );

      const keeperTokenAta = getAssociatedTokenAddressSync(
        order.inputMint,
        this.keeperKeypair.publicKey
      );

      const userDestTokenAta = getAssociatedTokenAddressSync(
        order.inputMint,
        order.owner
      );

      const configAccount = await this.program.account.protocolConfig.fetch(configPda);
      const protocolFeeAta = getAssociatedTokenAddressSync(
        order.inputMint,
        configAccount.feeRecipient
      );

      // Micro-Priority Fee Compute Optimization
      const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
        units: 40_000,
      });
      const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 25_000,
      });

      const tx = await this.program.methods
        .executeTranche()
        .accounts({
          config: configPda,
          order: orderPubkey,
          vault: vaultPda,
          oracleFeed: order.oracleFeed,
          keeperTokenAccount: keeperTokenAta,
          destinationTokenAccount: userDestTokenAta,
          protocolFeeVault: protocolFeeAta,
          keeper: this.keeperKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .preInstructions([modifyComputeUnits, addPriorityFee])
        .signers([this.keeperKeypair])
        .rpc();

      console.log(`[EXECUTED TRANCHE SUCCESS] TX Hash: ${tx}`);
    } catch (e: any) {
      console.warn(`[EXECUTION SKIPPED/FAILED] Order ${orderPubkey.toBase58()}: ${e.message}`);
    }
  }
}