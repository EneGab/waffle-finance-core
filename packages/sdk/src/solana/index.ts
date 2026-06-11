/**
 * Solana HTLC client for the WaffleFinance bridge.
 *
 * Mirrors the structure of SorobanHTLCClient and EthereumHTLCClient.
 * Signing is always delegated to the caller — this module never holds keys.
 *
 * NOTE: The on-chain Anchor program is deployed at SOLANA_HTLC_PROGRAM_ID.
 * Until a live program is available the client operates in "simulation" mode:
 * all mutating calls return a mock signature and log a warning so the rest of
 * the stack can be exercised end-to-end without a live devnet deployment.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  type TransactionSignature,
  type Commitment,
} from "@solana/web3.js";

/** 0x-prefixed HexString string (mirrors viem's HexString). */
type HexString = `0x${string}`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SolanaHTLCClientOptions {
  /** Solana RPC endpoint, e.g. https://api.devnet.solana.com */
  rpcUrl: string;
  /** Deployed Anchor program id for the HTLC contract. */
  programId: string;
  /** Commitment level for reads/confirmations. */
  commitment?: Commitment;
}

export interface SolanaCreateOrderInput {
  /** Sender public-key (base-58). */
  sender: string;
  /** Beneficiary public-key (base-58). */
  beneficiary: string;
  /** Refund address public-key (base-58). */
  refundAddress: string;
  /** SPL token mint. Use NATIVE_SOL_MINT for native SOL. */
  mint: string;
  /** Amount in lamports (or SPL token atomic units). */
  amount: bigint;
  /** Safety deposit in lamports. */
  safetyDeposit: bigint;
  /** sha256 hashlock, 0x-prefixed 32-byte HexString. */
  hashlockHex: HexString;
  /** Timelock duration in seconds from now. */
  timelockSeconds: number;
}

export interface SolanaOrderData {
  orderId: string;
  sender: string;
  beneficiary: string;
  refundAddress: string;
  mint: string;
  amount: bigint;
  safetyDeposit: bigint;
  hashlock: HexString;
  /** Absolute unix timestamp (seconds). */
  timelock: number;
  /** 0=Active 1=Claimed 2=Refunded */
  status: 0 | 1 | 2;
  preimage: HexString | null;
}

/** Minimal signer interface — delegates to Phantom / Backpack / headless keypair. */
export type SolanaSigner = {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
};

// ── Constants ──────────────────────────────────────────────────────────────

/** Represents native SOL (no SPL mint). */
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

// ── Client ─────────────────────────────────────────────────────────────────

export class SolanaHTLCClient {
  public readonly programId: string;
  private readonly connection: Connection;
  private readonly commitment: Commitment;
  private readonly simulation: boolean;

  constructor(opts: SolanaHTLCClientOptions) {
    this.programId = opts.programId;
    this.commitment = opts.commitment ?? "confirmed";
    this.connection = new Connection(opts.rpcUrl, this.commitment);
    // Run in simulation mode when the program id is a placeholder.
    this.simulation = opts.programId === "PLACEHOLDER" || opts.programId === "";
    if (this.simulation) {
      console.warn(
        "[SolanaHTLCClient] No program id configured — running in simulation mode. " +
          "All mutating calls return mock signatures."
      );
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async getOrder(orderId: string): Promise<SolanaOrderData | null> {
    if (this.simulation) {
      return null; // No on-chain state in simulation mode.
    }
    try {
      const programPk = new PublicKey(this.programId);
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("order"), Buffer.from(orderId)],
        programPk
      );
      const info = await this.connection.getAccountInfo(pda);
      if (!info) return null;
      // TODO: deserialise Anchor account data using the IDL once deployed.
      // For now return null to indicate "account found but not yet parseable".
      return null;
    } catch {
      return null;
    }
  }

  async getNativeBalance(address: string): Promise<bigint> {
    const pk = new PublicKey(address);
    const lamports = await this.connection.getBalance(pk, this.commitment);
    return BigInt(lamports);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Build, sign, and submit a `create_order` instruction.
   *
   * @returns The transaction signature and a deterministic order id derived
   *          from the hashlock so both chains can link the legs.
   */
  async createOrder(
    input: SolanaCreateOrderInput,
    signer: SolanaSigner
  ): Promise<{ txSignature: TransactionSignature; orderId: string }> {
    if (this.simulation) {
      const mockSig = "SIMULATION_" + input.hashlockHex.slice(2, 18);
      console.warn("[SolanaHTLCClient] simulation createOrder →", mockSig);
      return { txSignature: mockSig, orderId: "sim-" + input.hashlockHex.slice(2, 18) };
    }

    const tx = await this._buildCreateOrderTx(input, signer.publicKey);
    const signed = await signer.signTransaction(tx);
    const sig = await this.connection.sendRawTransaction(signed.serialize());
    await this.connection.confirmTransaction(sig, this.commitment);

    // Derive the on-chain PDA address as the canonical order id.
    const programPk = new PublicKey(this.programId);
    const hashlockBytes = Buffer.from(input.hashlockHex.slice(2), "hex");
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), hashlockBytes],
      programPk
    );

    return { txSignature: sig, orderId: pda.toBase58() };
  }

  async claimOrder(
    orderId: string,
    preimage: HexString,
    signer: SolanaSigner
  ): Promise<TransactionSignature> {
    if (this.simulation) {
      const mockSig = "SIMULATION_CLAIM_" + orderId.slice(0, 8);
      console.warn("[SolanaHTLCClient] simulation claimOrder →", mockSig);
      return mockSig;
    }

    const tx = await this._buildClaimTx(orderId, preimage, signer.publicKey);
    const signed = await signer.signTransaction(tx);
    const sig = await this.connection.sendRawTransaction(signed.serialize());
    await this.connection.confirmTransaction(sig, this.commitment);
    return sig;
  }

  async refundOrder(
    orderId: string,
    signer: SolanaSigner
  ): Promise<TransactionSignature> {
    if (this.simulation) {
      const mockSig = "SIMULATION_REFUND_" + orderId.slice(0, 8);
      console.warn("[SolanaHTLCClient] simulation refundOrder →", mockSig);
      return mockSig;
    }

    const tx = await this._buildRefundTx(orderId, signer.publicKey);
    const signed = await signer.signTransaction(tx);
    const sig = await this.connection.sendRawTransaction(signed.serialize());
    await this.connection.confirmTransaction(sig, this.commitment);
    return sig;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _buildCreateOrderTx(
    input: SolanaCreateOrderInput,
    feePayer: PublicKey
  ): Promise<Transaction> {
    const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer });

    // Placeholder instruction — replace with Anchor-generated call once IDL ships.
    tx.add(
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: new PublicKey(input.beneficiary),
        lamports: 0,
      })
    );

    return tx;
  }

  private async _buildClaimTx(
    _orderId: string,
    _preimage: HexString,
    feePayer: PublicKey
  ): Promise<Transaction> {
    const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer });
    tx.add(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: feePayer, lamports: 0 }));
    return tx;
  }

  private async _buildRefundTx(
    _orderId: string,
    feePayer: PublicKey
  ): Promise<Transaction> {
    const { blockhash } = await this.connection.getLatestBlockhash(this.commitment);
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer });
    tx.add(SystemProgram.transfer({ fromPubkey: feePayer, toPubkey: feePayer, lamports: 0 }));
    return tx;
  }
}
