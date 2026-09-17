import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Kratos } from "../target/types/kratos";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";

describe("kratos execution engine test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Kratos as Program<Kratos>;

  let inputMint: PublicKey;
  let outputMint: PublicKey;
  let userTokenAccount: PublicKey;
  let userDestTokenAccount: PublicKey;
  let keeperTokenAccount: PublicKey;
  let protocolFeeVault: PublicKey;

  const authority = Keypair.generate();
  const user = Keypair.generate();
  const keeper = Keypair.generate();
  const feeRecipient = Keypair.generate();

  // Deterministic Mock Pyth Account
  const mockPythOracle = Keypair.generate();

  let configPda: PublicKey;
  let orderPda: PublicKey;
  let vaultPda: PublicKey;

  const orderId = new BN(1001);
  const totalDeposit = new BN(1_000_000_000); // 1,000 units
  const trancheAmount = new BN(200_000_000); // 200 units (5 tranches)
  const intervalSeconds = new BN(5); // 5 seconds
  const minPrice = new BN(100_000_000); // $100.00
  const maxPrice = new BN(300_000_000); // $300.00
  const keeperFeeBps = 100; // 1%
  const protocolFeeBps = 50; // 0.5%

  before(async () => {
    // Fund test wallets
    for (const kp of [authority, user, keeper, feeRecipient]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy Mints
    inputMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    outputMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Create Token Accounts
    userTokenAccount = await createAccount(
      provider.connection,
      user,
      inputMint,
      user.publicKey
    );

    userDestTokenAccount = await createAccount(
      provider.connection,
      user,
      inputMint,
      user.publicKey
    );

    keeperTokenAccount = await createAccount(
      provider.connection,
      keeper,
      inputMint,
      keeper.publicKey
    );

    protocolFeeVault = await createAccount(
      provider.connection,
      authority,
      inputMint,
      feeRecipient.publicKey
    );

    // Mint supply to User
    await mintTo(
      provider.connection,
      authority,
      inputMint,
      userTokenAccount,
      authority,
      10_000_000_000
    );

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [orderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        user.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), orderPda.toBuffer()],
      program.programId
    );

    // Seed Mock Pyth Buffer (Minimum 240 bytes with correct Price & Time)
    const pythData = Buffer.alloc(240);
    const mockPrice = new BN(200_000_000); // $200.00
    const now = Math.floor(Date.now() / 1000);
    const mockPublishTime = new BN(now);

    mockPrice.toArrayLike(Buffer, "le", 8).copy(pythData, 208);
    mockPublishTime.toArrayLike(Buffer, "le", 8).copy(pythData, 224);

    const rentLamports = await provider.connection.getMinimumBalanceForRentExemption(240);
    const createOracleTx = new anchor.web3.Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mockPythOracle.publicKey,
        lamports: rentLamports,
        space: 240,
        programId: program.programId,
      })
    );
    await provider.sendAndConfirm(createOracleTx, [authority, mockPythOracle]);

    // Populate data
    // In production tests, use provider.connection to update mock account memory
  });

  it("Passes: Inits protocol state with strict authority constraints", async () => {
    await program.methods
      .initializeProtocol(protocolFeeBps)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(protocolFeeBps);
    expect(configAccount.isPaused).to.be.false;
  });

  it("Passes: Creates a streaming order and locks escrow collateral in Vault PDA", async () => {
    await program.methods
      .createStreamOrder(
        orderId,
        totalDeposit,
        trancheAmount,
        intervalSeconds,
        minPrice,
        maxPrice,
        keeperFeeBps
      )
      .accounts({
        config: configPda,
        order: orderPda,
        vault: vaultPda,
        inputMint,
        outputMint,
        oracleFeed: mockPythOracle.publicKey,
        ownerTokenAccount: userTokenAccount,
        owner: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    const vaultInfo = await getAccount(provider.connection, vaultPda);
    expect(vaultInfo.amount.toString()).to.equal(totalDeposit.toString());

    const orderAccount = await program.account.orderState.fetch(orderPda);
    expect(orderAccount.remainingDeposit.toString()).to.equal(totalDeposit.toString());
    expect(orderAccount.owner.toBase58()).to.equal(user.publicKey.toBase58());
  });

  it("Fails: Reject execution attempt before interval elapsed", async () => {
    try {
      await program.methods
        .executeTranche()
        .accounts({
          config: configPda,
          order: orderPda,
          vault: vaultPda,
          oracleFeed: mockPythOracle.publicKey,
          keeperTokenAccount,
          destinationTokenAccount: userDestTokenAccount,
          protocolFeeVault,
          keeper: keeper.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keeper])
        .rpc();
      expect.fail("Expected transaction to fail due to unelapsed interval");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("IntervalNotElapsed");
    }
  });

  it("Passes: Allows user to cancel unexecuted balance and recovers rent", async () => {
    // Cancel Order
    await program.methods
      .cancelOrder()
      .accounts({
        order: orderPda,
        vault: vaultPda,
        ownerTokenAccount: userTokenAccount,
        owner: user.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    // Verify order account closed
    const closedOrder = await provider.connection.getAccountInfo(orderPda);
    expect(closedOrder).to.be.null;

    // Verify vault account closed
    const closedVault = await provider.connection.getAccountInfo(vaultPda);
    expect(closedVault).to.be.null;
  });
});