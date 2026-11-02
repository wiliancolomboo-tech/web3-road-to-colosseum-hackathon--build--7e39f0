import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Aegisguard } from "../target/types/aegisguard";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";

describe("aegisguard", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Aegisguard as Program<Aegisguard>;

  let mint: PublicKey;
  let delegator: Keypair;
  let worker: Keypair;
  let rogueWorker: Keypair;
  let delegatorAta: PublicKey;
  let workerAta: PublicKey;

  const ESCROW_AMOUNT = new anchor.BN(10_000_000); // 10 tokens (6 decimals)

  before(async () => {
    delegator = Keypair.generate();
    worker = Keypair.generate();
    rogueWorker = Keypair.generate();

    // Airdrop SOL to signers
    for (const kp of [delegator, worker, rogueWorker]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    // Create Token Mint
    mint = await createMint(
      provider.connection,
      delegator,
      delegator.publicKey,
      null,
      6
    );

    // Create Token Accounts
    delegatorAta = await createAssociatedTokenAccount(
      provider.connection,
      delegator,
      mint,
      delegator.publicKey
    );

    workerAta = await createAssociatedTokenAccount(
      provider.connection,
      worker,
      mint,
      worker.publicKey
    );

    // Mint funds to Delegator ATA
    await mintTo(
      provider.connection,
      delegator,
      mint,
      delegatorAta,
      delegator,
      100_000_000
    );
  });

  it("Initializes an Escrow successfully with PDA token custody", async () => {
    const taskId = new anchor.BN(1001);
    const taskHash = Array.from(crypto.createHash("sha256").update("AI_INFERENCE_DATA_1").digest());
    const timeoutSeconds = new anchor.BN(3600); // 1 hour

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), delegator.publicKey.toBuffer(), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(taskId, taskHash, ESCROW_AMOUNT, timeoutSeconds)
      .accounts({
        delegator: delegator.publicKey,
        designatedWorker: worker.publicKey,
        mint: mint,
        delegatorTokenAccount: delegatorAta,
        escrow: escrowPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([delegator])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.taskId.toString()).to.equal("1001");
    expect(escrowAccount.escrowAmount.toString()).to.equal(ESCROW_AMOUNT.toString());
    expect(escrowAccount.designatedWorker.toBase58()).to.equal(worker.publicKey.toBase58());

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(vaultInfo.amount.toString()).to.equal(ESCROW_AMOUNT.toString());
  });

  it("Rejects fulfillment if invoked by an unauthorized worker", async () => {
    const taskId = new anchor.BN(1001);
    const resultHash = Array.from(crypto.createHash("sha256").update("PREMATURE_OUTPUT").digest());

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), delegator.publicKey.toBuffer(), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    const rogueAta = await createAssociatedTokenAccount(
      provider.connection,
      rogueWorker,
      mint,
      rogueWorker.publicKey
    );

    try {
      await program.methods
        .fulfillTask(resultHash)
        .accounts({
          worker: rogueWorker.publicKey,
          escrow: escrowPda,
          vault: vaultPda,
          workerTokenAccount: rogueAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([rogueWorker])
        .rpc();
      expect.fail("Unauthorized worker should have been blocked");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedWorker");
    }
  });

  it("Executes valid task fulfillment and disburses SPL tokens to the authorized worker", async () => {
    const taskId = new anchor.BN(1001);
    const resultHash = Array.from(crypto.createHash("sha256").update("VERIFIED_OUTPUT").digest());

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), delegator.publicKey.toBuffer(), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    const initialWorkerBalance = (await getAccount(provider.connection, workerAta)).amount;

    await program.methods
      .fulfillTask(resultHash)
      .accounts({
        worker: worker.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        workerTokenAccount: workerAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([worker])
      .rpc();

    const postWorkerBalance = (await getAccount(provider.connection, workerAta)).amount;
    expect(Number(postWorkerBalance - initialWorkerBalance)).to.equal(ESCROW_AMOUNT.toNumber());

    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowState.status).to.deep.equal({ fulfilled: {} });
  });

  it("Enforces circuit-breaker refund only after deadline expiration", async () => {
    const taskId = new anchor.BN(2002);
    const taskHash = Array.from(crypto.createHash("sha256").update("EXPIRING_TASK").digest());
    // 1-second timeout
    const timeoutSeconds = new anchor.BN(1);

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), delegator.publicKey.toBuffer(), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeEscrow(taskId, taskHash, ESCROW_AMOUNT, timeoutSeconds)
      .accounts({
        delegator: delegator.publicKey,
        designatedWorker: worker.publicKey,
        mint: mint,
        delegatorTokenAccount: delegatorAta,
        escrow: escrowPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([delegator])
      .rpc();

    // Sleep 3 seconds to guarantee deadline timestamp passage on local validator
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const initialDelegatorBal = (await getAccount(provider.connection, delegatorAta)).amount;

    await program.methods
      .claimRefund()
      .accounts({
        caller: delegator.publicKey,
        delegator: delegator.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        delegatorTokenAccount: delegatorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([delegator])
      .rpc();

    const postDelegatorBal = (await getAccount(provider.connection, delegatorAta)).amount;
    expect(Number(postDelegatorBal - initialDelegatorBal)).to.equal(ESCROW_AMOUNT.toNumber());

    const escrowState = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowState.status).to.deep.equal({ refunded: {} });
  });
});