import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SentinelFlow } from "../target/types/sentinel_flow";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("SentinelFlow Comprehensive QA Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SentinelFlow as Program<SentinelFlow>;

  const client = Keypair.generate();
  const contributor = Keypair.generate();
  const arbiter = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  const escrowId = new anchor.BN(Date.now());
  const milestoneCount = 2;
  const milestone1Amount = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const milestone2Amount = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const totalAmount = milestone1Amount.add(milestone2Amount);

  const hash1 = crypto.randomBytes(32);
  const hash2 = crypto.randomBytes(32);

  let escrowPda: PublicKey;
  let escrowBump: number;
  let vaultPda: PublicKey;
  let vaultBump: number;
  let milestone0Pda: PublicKey;
  let milestone1Pda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdropSignatures = await Promise.all([
      provider.connection.requestAirdrop(client.publicKey, 10 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(contributor.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(arbiter.publicKey, 2 * LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(unauthorizedUser.publicKey, 2 * LAMPORTS_PER_SOL),
    ]);

    for (const sig of airdropSignatures) {
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      });
    }

    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowPda.toBuffer()],
      program.programId
    );

    [milestone0Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), escrowPda.toBuffer(), Buffer.from([0])],
      program.programId
    );

    [milestone1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), escrowPda.toBuffer(), Buffer.from([1])],
      program.programId
    );
  });

  it("1. Successfully initializes an Escrow with multi-milestone configuration", async () => {
    await program.methods
      .initializeEscrow(
        escrowId,
        milestoneCount,
        [milestone1Amount, milestone2Amount],
        [Array.from(hash1), Array.from(hash2)]
      )
      .accounts({
        client: client.publicKey,
        contributor: contributor.publicKey,
        arbiter: arbiter.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.client.toBase58()).to.equal(client.publicKey.toBase58());
    expect(escrowAccount.contributor.toBase58()).to.equal(contributor.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(totalAmount.toNumber());
    expect(escrowAccount.totalMilestones).to.equal(2);
    expect(escrowAccount.completedMilestones).to.equal(0);
  });

  it("2. Funds the PDA Vault securely via client deposit", async () => {
    await program.methods
      .depositFunds(totalAmount)
      .accounts({
        client: client.publicKey,
        escrow: escrowPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.at.least(totalAmount.toNumber());
  });

  it("3. Contributor submits valid completion proof for Milestone 0", async () => {
    const submissionHash = crypto.randomBytes(32);

    await program.methods
      .submitMilestone(0, Array.from(submissionHash))
      .accounts({
        contributor: contributor.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([contributor])
      .rpc();

    const milestoneAccount = await program.account.milestoneRecord.fetch(milestone0Pda);
    expect(milestoneAccount.index).to.equal(0);
    expect(milestoneAccount.status).to.deep.equal({ submitted: {} });
  });

  it("4. Prevents unauthorized third party from approving milestone", async () => {
    try {
      await program.methods
        .approveMilestone(0)
        .accounts({
          client: unauthorizedUser.publicKey,
          contributor: contributor.publicKey,
          escrow: escrowPda,
          milestone: milestone0Pda,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorizedUser])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.toString()).to.include("Error");
    }
  });

  it("5. Client approves Milestone 0 and triggers atomic payout to Contributor", async () => {
    const initialContributorBalance = await provider.connection.getBalance(contributor.publicKey);

    await program.methods
      .approveMilestone(0)
      .accounts({
        client: client.publicKey,
        contributor: contributor.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    const finalContributorBalance = await provider.connection.getBalance(contributor.publicKey);
    expect(finalContributorBalance).to.be.greaterThan(initialContributorBalance);

    const milestoneAccount = await program.account.milestoneRecord.fetch(milestone0Pda);
    expect(milestoneAccount.status).to.deep.equal({ approved: {} });

    const escrowAccount = await program.account.escrowState.fetch(escrowPda);
    expect(escrowAccount.completedMilestones).to.equal(1);
  });

  it("6. Submits Milestone 1, raises dispute, and resolves through Arbiter", async () => {
    const proof1 = crypto.randomBytes(32);

    await program.methods
      .submitMilestone(1, Array.from(proof1))
      .accounts({
        contributor: contributor.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([contributor])
      .rpc();

    // Client raises formal dispute
    await program.methods
      .raiseDispute(1)
      .accounts({
        caller: client.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
      })
      .signers([client])
      .rpc();

    let milestone1 = await program.account.milestoneRecord.fetch(milestone1Pda);
    expect(milestone1.status).to.deep.equal({ disputed: {} });

    // Arbiter resolves dispute in favor of contributor
    await program.methods
      .resolveDispute(1, true)
      .accounts({
        arbiter: arbiter.publicKey,
        client: client.publicKey,
        contributor: contributor.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
        vault: vaultPda,
      })
      .signers([arbiter])
      .rpc();

    milestone1 = await program.account.milestoneRecord.fetch(milestone1Pda);
    expect(milestone1.status).to.deep.equal({ resolvedPaid: {} });
  });
});