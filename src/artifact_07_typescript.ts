import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Aegisflow } from "../target/types/aegisflow";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("aegisflow-integration-tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Aegisflow as Program<Aegisflow>;

  const client = Keypair.generate();
  const providerUser = Keypair.generate();
  const arbiter = Keypair.generate();
  const attacker = Keypair.generate();

  const escrowId = new anchor.BN(Date.now());
  const totalAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);
  const milestoneCount = 2;
  const disputeWindowSlots = new anchor.BN(150);

  let escrowPda: PublicKey;
  let vaultPda: PublicKey;

  before(async () => {
    // Fund accounts
    const airdropSigClient = await provider.connection.requestAirdrop(client.publicKey, 5 * LAMPORTS_PER_SOL);
    const airdropSigAttacker = await provider.connection.requestAirdrop(attacker.publicKey, 1 * LAMPORTS_PER_SOL);
    const latestBlockhash = await provider.connection.getLatestBlockhash();
    
    await provider.connection.confirmTransaction({
      signature: airdropSigClient,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), client.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), client.publicKey.toBuffer(), escrowId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Successfully initializes an escrow with deterministic PDA vault", async () => {
    await program.methods
      .initializeEscrow(escrowId, totalAmount, milestoneCount, disputeWindowSlots)
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        client: client.publicKey,
        provider: providerUser.publicKey,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([client])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.client.toBase58()).to.equal(client.publicKey.toBase58());
    expect(escrowAccount.provider.toBase58()).to.equal(providerUser.publicKey.toBase58());
    expect(escrowAccount.totalAmount.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);
    expect(escrowAccount.currentMilestone).to.equal(0);
    expect(escrowAccount.milestoneCount).to.equal(2);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(2 * LAMPORTS_PER_SOL);
  });

  it("2. Rejects unauthorized provider milestone submissions", async () => {
    const dummyHash = Array.from(crypto.createHash("sha256").update("proof1").digest());

    try {
      await program.methods
        .submitMilestone(0, dummyHash)
        .accounts({
          escrowAccount: escrowPda,
          provider: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown unauthorized provider error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedProvider");
    }
  });

  it("3. Provider submits Milestone #0 with valid proof digest", async () => {
    const dummyHash = Array.from(crypto.createHash("sha256").update("deliverable_v1").digest());

    await program.methods
      .submitMilestone(0, dummyHash)
      .accounts({
        escrowAccount: escrowPda,
        provider: providerUser.publicKey,
      })
      .signers([providerUser])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.state).to.deep.equal({ submitted: {} });
    expect(escrowAccount.lastProofHash).to.deep.equal(dummyHash);
  });

  it("4. Releases Milestone #0: Tranches 50% lamports to provider", async () => {
    const initialProviderBalance = await provider.connection.getBalance(providerUser.publicKey);

    await program.methods
      .releaseMilestone(0)
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        provider: providerUser.publicKey,
        authority: client.publicKey,
      })
      .signers([client])
      .rpc();

    const finalProviderBalance = await provider.connection.getBalance(providerUser.publicKey);
    expect(finalProviderBalance - initialProviderBalance).to.equal(1 * LAMPORTS_PER_SOL);

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.currentMilestone).to.equal(1);
    expect(escrowAccount.releasedAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
  });

  it("5. Completes Milestone #1 and validates state transitions to Completed", async () => {
    const dummyHash = Array.from(crypto.createHash("sha256").update("final_delivery").digest());

    await program.methods
      .submitMilestone(1, dummyHash)
      .accounts({
        escrowAccount: escrowPda,
        provider: providerUser.publicKey,
      })
      .signers([providerUser])
      .rpc();

    await program.methods
      .releaseMilestone(1)
      .accounts({
        escrowAccount: escrowPda,
        vault: vaultPda,
        provider: providerUser.publicKey,
        authority: client.publicKey,
      })
      .signers([client])
      .rpc();

    const escrowAccount = await program.account.escrowAccount.fetch(escrowPda);
    expect(escrowAccount.state).to.deep.equal({ completed: {} });
    expect(escrowAccount.releasedAmount.toNumber()).to.equal(2 * LAMPORTS_PER_SOL);

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.equal(0);
  });
});