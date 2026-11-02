import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NexusStream } from "../target/types/nexus_stream";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";
import crypto from "crypto";

describe("nexus_stream escrow and settlement tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.NexusStream as Program<NexusStream>;

  const payer = (provider.wallet as anchor.Wallet).payer;
  const worker = Keypair.generate();
  const arbiter = Keypair.generate();
  const feeCollector = Keypair.generate();

  const escrowId = `ESC-${Date.now()}`;
  let escrowPda: PublicKey;
  let escrowBump: number;

  before(async () => {
    // Airdrop SOL to test accounts
    const sig1 = await provider.connection.requestAirdrop(worker.publicKey, 2 * LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(arbiter.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("nexus_escrow"), payer.publicKey.toBuffer(), Buffer.from(escrowId)],
      program.programId
    );
  });

  it("1. Initializes escrow with locked capital and verified SLA terms", async () => {
    const depositAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const nowSecs = Math.floor(Date.now() / 1000);
    const slaDeadline = new anchor.BN(nowSecs + 3600); // 1 hour from now
    const autoReleaseTimeout = new anchor.BN(nowSecs + 7200); // 2 hours from now

    const balanceBefore = await provider.connection.getBalance(payer.publicKey);

    await program.methods
      .initializeEscrow(escrowId, depositAmount, slaDeadline, autoReleaseTimeout)
      .accounts({
        escrowAccount: escrowPda,
        payer: payer.publicKey,
        worker: worker.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);

    assert.equal(escrowAccount.payer.toBase58(), payer.publicKey.toBase58());
    assert.equal(escrowAccount.worker.toBase58(), worker.publicKey.toBase58());
    assert.equal(escrowAccount.arbiter.toBase58(), arbiter.publicKey.toBase58());
    assert.equal(escrowAccount.amount.toNumber(), depositAmount.toNumber());
    assert.deepEqual(escrowAccount.status, { activeLocked: {} });
    assert.equal(escrowAccount.escrowId, escrowId);

    const escrowBalance = await provider.connection.getBalance(escrowPda);
    assert.isAtLeast(escrowBalance, depositAmount.toNumber());
  });

  it("2. Rejects unauthorized worker submitting milestone deliverable", async () => {
    const impostor = Keypair.generate();
    const fakeHash = Array.from(crypto.createHash("sha256").update("proof").digest());

    try {
      await program.methods
        .submitMilestone(fakeHash)
        .accounts({
          escrowAccount: escrowPda,
          worker: impostor.publicKey,
        })
        .signers([impostor])
        .rpc();
      assert.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.message).to.include("Unauthorized");
    }
  });

  it("3. Worker submits deliverable artifact hash and moves status to Verifying", async () => {
    const deliverablePayload = "AGENT_OUTPUT_METRICS_V1_CONFIRMED";
    const artifactHash = Array.from(
      crypto.createHash("sha256").update(deliverablePayload).digest()
    );

    await program.methods
      .submitMilestone(artifactHash)
      .accounts({
        escrowAccount: escrowPda,
        worker: worker.publicKey,
      })
      .signers([worker])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    assert.deepEqual(escrowAccount.status, { verifying: {} });
    assert.deepEqual(escrowAccount.artifactHash, artifactHash);
    assert.isAbove(escrowAccount.submittedAt.toNumber(), 0);
  });

  it("4. Payer approves delivery, disbursing capital atomically with protocol fee", async () => {
    const workerBalanceBefore = await provider.connection.getBalance(worker.publicKey);
    const feeCollectorBefore = await provider.connection.getBalance(feeCollector.publicKey);

    await program.methods
      .completeAndDisburse()
      .accounts({
        escrowAccount: escrowPda,
        authority: payer.publicKey,
        worker: worker.publicKey,
        feeTreasury: feeCollector.publicKey,
      })
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    assert.deepEqual(escrowAccount.status, { completed: {} });

    const workerBalanceAfter = await provider.connection.getBalance(worker.publicKey);
    const feeCollectorAfter = await provider.connection.getBalance(feeCollector.publicKey);

    // 1 SOL total: 1.5% fee = 0.015 SOL, Worker payout = 0.985 SOL
    const expectedFee = (1 * LAMPORTS_PER_SOL * 150) / 10000;
    const expectedWorkerPayout = 1 * LAMPORTS_PER_SOL - expectedFee;

    assert.equal(feeCollectorAfter - feeCollectorBefore, expectedFee);
    assert.equal(workerBalanceAfter - workerBalanceBefore, expectedWorkerPayout);
  });

  it("5. Prevents double-spending or re-disbursement on completed escrows", async () => {
    try {
      await program.methods
        .completeAndDisburse()
        .accounts({
          escrowAccount: escrowPda,
          authority: payer.publicKey,
          worker: worker.publicKey,
          feeTreasury: feeCollector.publicKey,
        })
        .rpc();
      assert.fail("Should not allow re-disbursement on already completed escrow");
    } catch (err: any) {
      expect(err.message).to.include("InvalidState");
    }
  });

  it("6. Arbiter dispute resolution path splits capital accurately", async () => {
    const disputeEscrowId = `DISPUTE-${Date.now()}`;
    const [disputePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nexus_escrow"), payer.publicKey.toBuffer(), Buffer.from(disputeEscrowId)],
      program.programId
    );

    const amount = new anchor.BN(2 * LAMPORTS_PER_SOL);
    const nowSecs = Math.floor(Date.now() / 1000);

    // Initialize second escrow
    await program.methods
      .initializeEscrow(disputeEscrowId, amount, new anchor.BN(nowSecs + 100), new anchor.BN(nowSecs + 200))
      .accounts({
        escrowAccount: disputePda,
        payer: payer.publicKey,
        worker: worker.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Worker submits milestone
    const fakeHash = Array.from(crypto.createHash("sha256").update("contested-work").digest());
    await program.methods
      .submitMilestone(fakeHash)
      .accounts({
        escrowAccount: disputePda,
        worker: worker.publicKey,
      })
      .signers([worker])
      .rpc();

    // Arbiter resolves dispute: 50% split (5000 bps)
    const payerBalanceBefore = await provider.connection.getBalance(payer.publicKey);
    const workerBalanceBefore = await provider.connection.getBalance(worker.publicKey);

    await program.methods
      .resolveDispute(5000)
      .accounts({
        escrowAccount: disputePda,
        arbiter: arbiter.publicKey,
        payer: payer.publicKey,
        worker: worker.publicKey,
      })
      .signers([arbiter])
      .rpc();

    const workerBalanceAfter = await provider.connection.getBalance(worker.publicKey);
    const payerBalanceAfter = await provider.connection.getBalance(payer.publicKey);

    assert.equal(workerBalanceAfter - workerBalanceBefore, 1 * LAMPORTS_PER_SOL);
    assert.equal(payerBalanceAfter - payerBalanceBefore, 1 * LAMPORTS_PER_SOL);
  });
});