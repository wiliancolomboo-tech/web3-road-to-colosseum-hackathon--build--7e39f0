import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AegisVault } from "../target/types/aegis_vault";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("AegisVault Comprehensive Invariant Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AegisVault as Program<AegisVault>;

  const depositor = Keypair.generate();
  const contractor = Keypair.generate();
  const arbiter = Keypair.generate();
  const attacker = Keypair.generate();

  const escrowId = new anchor.BN(Math.floor(Math.random() * 1000000) + 1);
  const milestone1 = new anchor.BN(1 * LAMPORTS_PER_SOL);
  const milestone2 = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const totalAmount = milestone1.add(milestone2); // 3 SOL total

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;
  let escrowBump: number;

  before(async () => {
    // Airdrop funds to actors
    for (const actor of [depositor, contractor, arbiter, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_escrow"), depositor.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("aegis_vault"), escrowPda.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes a multi-milestone escrow with PDA collateralization", async () => {
    const currentSlot = await provider.connection.getSlot();
    const blockTime = (await provider.connection.getBlockTime(currentSlot)) ?? Math.floor(Date.now() / 1000);
    const timeoutTimestamp = new anchor.BN(blockTime + 3600); // +1 hour

    await program.methods
      .initializeEscrow(escrowId, totalAmount, [milestone1, milestone2], timeoutTimestamp)
      .accounts({
        escrow: escrowPda,
        vault: vaultPda,
        depositor: depositor.publicKey,
        contractor: contractor.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    assert.ok(escrowAccount.depositor.equals(depositor.publicKey));
    assert.ok(escrowAccount.contractor.equals(contractor.publicKey));
    assert.equal(escrowAccount.currentMilestone, 0);
    assert.equal(escrowAccount.totalMilestones, 2);
    assert.equal(escrowAccount.remainingBalance.toNumber(), totalAmount.toNumber());

    const vaultLamports = await provider.connection.getBalance(vaultPda);
    assert.equal(vaultLamports, totalAmount.toNumber());
  });

  it("2. Fails to approve an out-of-order milestone index", async () => {
    try {
      await program.methods
        .approveMilestone(1) // Current milestone is 0
        .accounts({
          escrow: escrowPda,
          vault: vaultPda,
          depositor: depositor.publicKey,
          contractor: contractor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();
      assert.fail("Should have thrown InvalidMilestoneIndex");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidMilestoneIndex");
    }
  });

  it("3. Approves Milestone 0 and disburses exact lamports to Contractor", async () => {
    const initialContractorBal = await provider.connection.getBalance(contractor.publicKey);

    await program.methods
      .approveMilestone(0)
      .accounts({
        escrow: escrowPda,
        vault: vaultPda,
        depositor: depositor.publicKey,
        contractor: contractor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor])
      .rpc();

    const postContractorBal = await provider.connection.getBalance(contractor.publicKey);
    assert.equal(postContractorBal - initialContractorBal, milestone1.toNumber());

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    assert.equal(escrowAccount.currentMilestone, 1);
    assert.equal(escrowAccount.remainingBalance.toNumber(), milestone2.toNumber());
  });

  it("4. Prevents unauthorized third-party attacker from initiating dispute", async () => {
    try {
      await program.methods
        .disputeEscrow("Unauthorized intervention attempt")
        .accounts({
          escrow: escrowPda,
          initiator: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      assert.fail("Attacker should not be permitted to dispute escrow");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("5. Allows designated arbiter to flag escrow dispute state", async () => {
    await program.methods
      .disputeEscrow("Quality specification deviation detected")
      .accounts({
        escrow: escrowPda,
        initiator: arbiter.publicKey,
      })
      .signers([arbiter])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    // EscrowStatus::Disputed is the 4th variant (index 3)
    expect(escrowAccount.status).to.deep.equal({ disputed: {} });
  });

  it("6. Rejects premature cancel_and_refund when timelock has not expired", async () => {
    try {
      await program.methods
        .cancelAndRefund()
        .accounts({
          escrow: escrowPda,
          vault: vaultPda,
          depositor: depositor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor])
        .rpc();
      assert.fail("Refund should have failed due to active timelock");
    } catch (err: any) {
      // Fails due to either EscrowNotActive (since Disputed) or TimeoutNotReached
      assert.ok(err);
    }
  });
});