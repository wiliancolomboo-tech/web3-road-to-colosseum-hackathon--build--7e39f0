import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import * as crypto from "crypto";

describe("chrono_lock test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load program from workspace
  const program = anchor.workspace.ChronoLock as Program;
  const sponsor = anchor.web3.Keypair.generate();
  const beneficiary = anchor.web3.Keypair.generate();
  const keeper = anchor.web3.Keypair.generate();
  const unauthorizedAttacker = anchor.web3.Keypair.generate();

  const escrowId = new BN(1001);
  const totalAmount = new BN(2 * web3.LAMPORTS_PER_SOL);
  const milestoneAmounts = [
    new BN(1 * web3.LAMPORTS_PER_SOL),
    new BN(1 * web3.LAMPORTS_PER_SOL),
  ];

  // Raw secret deliverable digests
  const deliverable1Secret = "v1.0.0-release-core-smart-contract";
  const hash1 = crypto.createHash("sha256").update(deliverable1Secret).digest();

  const deliverable2Secret = "v1.1.0-release-security-audit-report";
  const hash2 = crypto.createHash("sha256").update(deliverable2Secret).digest();

  let escrowPDA: web3.PublicKey;
  let vaultPDA: web3.PublicKey;
  let escrowBump: number;
  let vaultBump: number;

  before(async () => {
    // Airdrop funding to actor accounts
    const airdropSponsor = await provider.connection.requestAirdrop(
      sponsor.publicKey,
      10 * web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSponsor);

    const airdropKeeper = await provider.connection.requestAirdrop(
      keeper.publicKey,
      2 * web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropKeeper);

    const airdropAttacker = await provider.connection.requestAirdrop(
      unauthorizedAttacker.publicKey,
      2 * web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropAttacker);

    // Derive deterministic PDAs
    [escrowPDA, escrowBump] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), sponsor.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPDA, vaultBump] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), sponsor.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Successfully initializes an escrow with 2 milestones", async () => {
    const disputeWindowSeconds = new BN(60); // 60s window for test purposes

    await program.methods
      .initializeEscrow(
        escrowId,
        totalAmount,
        2,
        disputeWindowSeconds,
        [Array.from(hash1), Array.from(hash2)],
        milestoneAmounts
      )
      .accounts({
        sponsor: sponsor.publicKey,
        beneficiary: beneficiary.publicKey,
        escrowState: escrowPDA,
        vault: vaultPDA,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([sponsor])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPDA);
    expect(escrowAccount.sponsor.toBase58()).to.equal(sponsor.publicKey.toBase58());
    expect(escrowAccount.beneficiary.toBase58()).to.equal(beneficiary.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(2 * web3.LAMPORTS_PER_SOL);
    expect(escrowAccount.remainingBalance.toNumber()).to.equal(2 * web3.LAMPORTS_PER_SOL);
    expect(escrowAccount.currentMilestone).to.equal(0);

    const vaultBalance = await provider.connection.getBalance(vaultPDA);
    expect(vaultBalance).to.equal(2 * web3.LAMPORTS_PER_SOL);
  });

  it("2. Rejects milestone submission if caller is NOT the beneficiary", async () => {
    try {
      await program.methods
        .submitMilestone(Array.from(hash1))
        .accounts({
          beneficiary: unauthorizedAttacker.publicKey,
          escrowState: escrowPDA,
        })
        .signers([unauthorizedAttacker])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.message).to.include("UnauthorizedBeneficiary");
    }
  });

  it("3. Rejects milestone submission with an invalid deliverable hash", async () => {
    const bogusHash = crypto.createHash("sha256").update("invalid-code").digest();

    try {
      await program.methods
        .submitMilestone(Array.from(bogusHash))
        .accounts({
          beneficiary: beneficiary.publicKey,
          escrowState: escrowPDA,
        })
        .signers([beneficiary])
        .rpc();
      expect.fail("Should have rejected hash mismatch");
    } catch (err: any) {
      expect(err.message).to.include("HashMismatch");
    }
  });

  it("4. Beneficiary submits correct milestone hash for Milestone #0", async () => {
    await program.methods
      .submitMilestone(Array.from(hash1))
      .accounts({
        beneficiary: beneficiary.publicKey,
        escrowState: escrowPDA,
      })
      .signers([beneficiary])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPDA);
    expect(escrowAccount.milestones[0].status).to.deep.equal({ submitted: {} });
    expect(escrowAccount.lastSubmissionTime.toNumber()).to.be.greaterThan(0);
  });

  it("5. Sponsor approves Milestone #0 and disburses funds to beneficiary", async () => {
    const beneficiaryPreBalance = await provider.connection.getBalance(beneficiary.publicKey);

    await program.methods
      .approveMilestone()
      .accounts({
        sponsor: sponsor.publicKey,
        beneficiary: beneficiary.publicKey,
        escrowState: escrowPDA,
        vault: vaultPDA,
      })
      .signers([sponsor])
      .rpc();

    const beneficiaryPostBalance = await provider.connection.getBalance(beneficiary.publicKey);
    expect(beneficiaryPostBalance - beneficiaryPreBalance).to.equal(1 * web3.LAMPORTS_PER_SOL);

    const escrowAccount = await program.account.escrowState.fetch(escrowPDA);
    expect(escrowAccount.currentMilestone).to.equal(1);
    expect(escrowAccount.remainingBalance.toNumber()).to.equal(1 * web3.LAMPORTS_PER_SOL);
  });

  it("6. Beneficiary submits Milestone #1 deliverable hash", async () => {
    await program.methods
      .submitMilestone(Array.from(hash2))
      .accounts({
        beneficiary: beneficiary.publicKey,
        escrowState: escrowPDA,
      })
      .signers([beneficiary])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPDA);
    expect(escrowAccount.milestones[1].status).to.deep.equal({ submitted: {} });
  });

  it("7. Fails keeper release when dispute window has NOT elapsed", async () => {
    try {
      await program.methods
        .keeperAutoRelease()
        .accounts({
          keeper: keeper.publicKey,
          beneficiary: beneficiary.publicKey,
          escrowState: escrowPDA,
          vault: vaultPDA,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Should have failed because dispute window is still active");
    } catch (err: any) {
      expect(err.message).to.include("DisputeWindowStillActive");
    }
  });

  it("8. Dispute window: Sponsor successfully raises a dispute", async () => {
    const disputeReasonCode = 404; // e.g. Deliverable artifact corrupted / broken test suite

    await program.methods
      .raiseDispute(disputeReasonCode)
      .accounts({
        sponsor: sponsor.publicKey,
        escrowState: escrowPDA,
      })
      .signers([sponsor])
      .rpc();

    const escrowAccount = await program.account.escrowState.fetch(escrowPDA);
    expect(escrowAccount.state).to.deep.equal({ disputed: {} });
    expect(escrowAccount.milestones[1].status).to.deep.equal({ disputed: {} });
  });
});