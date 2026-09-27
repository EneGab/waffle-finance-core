/**
 * @file event-ordering.ts
 *
 * Guard rails for event ordering and stale block detection.
 *
 * Problem
 * -------
 * Chain listeners receive events asynchronously:
 *   - Events may arrive out of order (e.g. claim before created)
 *   - Events may reference stale block numbers (forks, rollbacks)
 *   - Multiple chains emit independently, so cross-chain ordering is not guaranteed
 *
 * This module provides:
 *   - Per-chain event ordering guards
 *   - Block height watermark tracking
 *   - Staleness detection and rejection
 *   - Out-of-order event buffering
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Event metadata used for ordering and staleness checks.
 */
export interface EventMetadata {
  /** Chain identifier (ethereum, soroban, solana). */
  chain: EthereumChain | SorobanChain | SolanaChain;
  /** On-chain event type (order_created, order_claimed, order_refunded). */
  eventType: EventType;
  /** On-chain order ID. */
  orderId: bigint;
  /** Block number / slot / ledger when the event occurred. */
  blockNumber: number | bigint;
  /** Transaction timestamp or slot timestamp. */
  timestamp?: number;
}

export type EthereumChain = 'ethereum';
export type SorobanChain = 'soroban';
export type SolanaChain = 'solana';
export type Chain = EthereumChain | SorobanChain | SolanaChain;

export type EventType = 'order_created' | 'order_claimed' | 'order_refunded';

/**
 * Event record with ordering metadata.
 */
export interface EventRecord {
  metadata: EventMetadata;
  /** Unix timestamp when the event was received by the listener. */
  receivedAt: number;
  /** Whether the event passed all ordering/staleness checks. */
  valid: boolean;
  /** Reason for invalidity if valid=false. */
  rejectionReason?: string;
  /** Expected block height for this event based on chain state. */
  expectedBlockHeight?: number | bigint;
  /** Actual block height when the event was observed on-chain. */
  observedBlockHeight: number | bigint;
}

/**
 * Chain state snapshot used for ordering validation.
 */
export interface ChainState {
  chain: Chain;
  /** Highest block/slot observed so far. */
  maxHeight: number | bigint;
  /** Per-order order ID sequence (monotonically increasing). */
  orderIdSequence: Map<bigint, bigint>;
  /** Last timestamp observed per order. */
  lastTimestamp: Map<bigint, number>;
}

// ── Error types ───────────────────────────────────────────────────────────────

export class OrderingError extends Error {
  constructor(
    public readonly chain: Chain,
    public readonly orderId: bigint,
    public readonly eventType: EventType,
    public readonly reason: string,
    public readonly observedBlock?: number | bigint,
    public readonly expectedBlock?: number | bigint,
  ) {
    super(`[${chain}] orderId=${orderId}, eventType=${eventType}: ${reason}`);
    this.name = 'OrderingError';
  }
}

export class StalenessError extends Error {
  constructor(
    public readonly chain: Chain,
    public readonly blockNumber: number | bigint,
    public readonly maxAllowed: number | bigint,
    public readonly reason: string = 'block is stale',
  ) {
    super(`[${chain}] block=${blockNumber} is stale (max=${maxAllowed}): ${reason}`);
    this.name = 'StalenessError';
  }
}

// ── Event Order Guard ─────────────────────────────────────────────────────────

/**
 * Tracks per-chain ordering state and validates events.
 *
 * Key guarantees:
 *   - Events for the same order must arrive in: created → claimed/refunded
 *   - Block numbers must be monotonically increasing (per chain)
 *   - Events with stale block numbers are rejected
 */
export class EventOrderGuard {
  private readonly chainStates = new Map<Chain, ChainState>();
  private readonly maxBlockAge: number;
  private readonly orderBufferMs: number;

  /**
   * @param maxBlockAge  Maximum age (in blocks/slots) for an event to be considered valid.
   *                     Events older than this relative to the current head are rejected.
   * @param orderBufferMs  Time window (ms) to buffer out-of-order events for the same order.
   *                       If events arrive outside this window, they are rejected.
   */
  constructor(opts: { maxBlockAge?: number; orderBufferMs?: number } = {}) {
    this.maxBlockAge = opts.maxBlockAge ?? 100;
    this.orderBufferMs = opts.orderBufferMs ?? 30_000;
  }

  /**
   * Get or create the ChainState for a chain.
   */
  private getChainState(chain: Chain): ChainState {
    if (!this.chainStates.has(chain)) {
      this.chainStates.set(chain, {
        chain,
        maxHeight: 0n,
        orderIdSequence: new Map<bigint, bigint>(),
        lastTimestamp: new Map<bigint, number>(),
      });
    }
    return this.chainStates.get(chain)!;
  }

  /**
   * Update the chain's highest observed block/slot.
   *
   * Call this before processing any events from a new poll tick.
   * Updates the maxHeight watermark for all subsequent validation.
   */
  updateChainHead(chain: Chain, newHeight: number | bigint): void {
    const state = this.getChainState(chain);
    const newHeightBig = BigInt(newHeight);
    if (newHeightBig > state.maxHeight) {
      state.maxHeight = newHeightBig;
    }
  }

  /**
   * Validate an event against chain ordering rules.
   *
   * Returns the event record with validation result.
   * Throws OrderingError or StalenessError if validation fails.
   */
  validateEvent(metadata: EventMetadata): EventRecord {
    const state = this.getChainState(metadata.chain);
    const blockBig = BigInt(metadata.blockNumber);

    // ── Staleness check ────────────────────────────────────────────────────
    const staleness = this.checkStaleness(metadata.chain, blockBig, state.maxHeight);
    if (staleness) {
      return {
        metadata,
        receivedAt: Date.now(),
        valid: false,
        rejectionReason: staleness.message,
        expectedBlockHeight: state.maxHeight,
        observedBlockHeight: blockBig,
      };
    }

    // ── Ordering check by event type ───────────────────────────────────────
    const eventOrder = this.getExpectedEventOrder(metadata.eventType);
    const lastOrderId = state.orderIdSequence.get(metadata.orderId) ?? 0n;
    const expectedOrderId = lastOrderId + 1n;

    if (metadata.orderId < lastOrderId) {
      // Order ID regressed - possible fork or replay
      const error = new OrderingError(
        metadata.chain,
        metadata.orderId,
        metadata.eventType,
        `order ID regressed from ${lastOrderId} to ${metadata.orderId} - possible fork or replay attack`,
        blockBig,
        lastOrderId,
      );
      return {
        metadata,
        receivedAt: Date.now(),
        valid: false,
        rejectionReason: error.message,
        expectedBlockHeight: state.maxHeight,
        observedBlockHeight: blockBig,
      };
    }

    // ── Event type sequence validation ─────────────────────────────────────
    // For now, we just ensure order IDs are monotonically increasing
    // More complex validation can be added based on business logic
    state.orderIdSequence.set(metadata.orderId, metadata.orderId);

    // ── Timestamp validation (if provided) ────────────────────────────────
    if (metadata.timestamp !== undefined) {
      const lastTs = state.lastTimestamp.get(metadata.orderId) ?? 0;
      if (metadata.timestamp < lastTs - this.orderBufferMs) {
        // Timestamp went backwards significantly - possible stale data
        const error = new OrderingError(
          metadata.chain,
          metadata.orderId,
          metadata.eventType,
          `timestamp regressed from ${lastTs} to ${metadata.timestamp} - possible stale data`,
          blockBig,
        );
        return {
          metadata,
          receivedAt: Date.now(),
          valid: false,
          rejectionReason: error.message,
          expectedBlockHeight: state.maxHeight,
          observedBlockHeight: blockBig,
        };
      }
      state.lastTimestamp.set(metadata.orderId, metadata.timestamp);
    }

    // ── All checks passed ──────────────────────────────────────────────────
    return {
      metadata,
      receivedAt: Date.now(),
      valid: true,
      expectedBlockHeight: state.maxHeight,
      observedBlockHeight: blockBig,
    };
  }

  /**
   * Get the expected event order for validation.
   */
  private getExpectedEventOrder(eventType: EventType): number {
    const order: Record<EventType, number> = {
      order_created: 1,
      order_claimed: 2,
      order_refunded: 2, // claimed or refunded, both valid after created
    };
    return order[eventType];
  }

  /**
   * Check if a block number is stale relative to chain head.
   *
   * Returns an error if stale, undefined if valid.
   */
  private checkStaleness(
    chain: Chain,
    blockNumber: bigint,
    maxHeight: bigint,
  ): Error | undefined {
    if (blockNumber > maxHeight) {
      // Future block - not necessarily stale, but suspicious
      return new StalenessError(
        chain,
        blockNumber,
        maxHeight,
        'block is from the future',
      );
    }

    const age = Number(maxHeight - blockNumber);
    if (age > this.maxBlockAge) {
      return new StalenessError(
        chain,
        blockNumber,
        maxHeight,
        `block is ${age} blocks old (max allowed: ${this.maxBlockAge})`,
      );
    }

    return undefined;
  }

  /**
   * Get the current chain state (for debugging/metrics).
   */
  getChainState(chain: Chain): ChainState | undefined {
    return this.chainStates.get(chain);
  }

  /**
   * Get all chain states.
   */
  getAllChainStates(): Map<Chain, ChainState> {
    return this.chainStates;
  }

  /**
   * Reset chain state (useful for testing).
   */
  resetChain(chain: Chain): void {
    this.chainStates.delete(chain);
  }

  /**
   * Reset all chain states.
   */
  resetAll(): void {
    this.chainStates.clear();
  }
}

// ── Event Ordering Monitor ────────────────────────────────────────────────────

/**
 * Monitors event ordering and provides metrics/logging for operators.
 */
export class EventOrderMonitor {
  private readonly orderGuard: EventOrderGuard;
  private readonly validCount = 0;
  private readonly invalidCount = 0;
  private readonly rejectedCount = 0;
  private readonly staleCount = 0;

  constructor(opts?: { maxBlockAge?: number; orderBufferMs?: number }) {
    this.orderGuard = new EventOrderGuard(opts);
  }

  /**
   * Process an event and return validation result.
   */
  processEvent(metadata: EventMetadata): EventRecord {
    try {
      const record = this.orderGuard.validateEvent(metadata);
      if (record.valid) {
        this.validCount++;
      } else {
        this.rejectedCount++;
        if (record.rejectionReason?.includes('stale') || record.rejectionReason?.includes('block')) {
          this.staleCount++;
        } else {
          this.invalidCount++;
        }
      }
      return record;
    } catch (err) {
      this.rejectedCount++;
      if (err instanceof StalenessError) {
        this.staleCount++;
      } else {
        this.invalidCount++;
      }
      return {
        metadata,
        receivedAt: Date.now(),
        valid: false,
        rejectionReason: err instanceof Error ? err.message : String(err),
        expectedBlockHeight: this.orderGuard.getChainState(metadata.chain)?.maxHeight,
        observedBlockHeight: metadata.blockNumber,
      };
    }
  }

  /**
   * Get metrics summary.
   */
  getMetrics(): {
    valid: number;
    rejected: number;
    invalid: number;
    stale: number;
    total: number;
  } {
    const total = this.validCount + this.rejectedCount;
    return {
      valid: this.validCount,
      rejected: this.rejectedCount,
      invalid: this.invalidCount,
      stale: this.staleCount,
      total,
    };
  }

  /**
   * Get chain states (for debugging).
   */
  getChainStates(): Map<Chain, ChainState> {
    return this.orderGuard.getAllChainStates();
  }

  /**
   * Reset all counters and states.
   */
  reset(): void {
    this.orderGuard.resetAll();
    this.validCount = 0;
    this.invalidCount = 0;
    this.rejectedCount = 0;
    this.staleCount = 0;
  }
}

// ── Builder pattern helpers ───────────────────────────────────────────────────

/**
 * Builder for EventMetadata.
 */
export class EventMetadataBuilder {
  private metadata: EventMetadata;

  constructor(chain: Chain, eventType: EventType, orderId: bigint, blockNumber: number | bigint) {
    this.metadata = {
      chain,
      eventType,
      orderId,
      blockNumber,
    };
  }

  timestamp(ts: number): this {
    this.metadata.timestamp = ts;
    return this;
  }

  build(): EventMetadata {
    return this.metadata;
  }
}

/**
 * Builder for EventOrderGuard configuration.
 */
export class EventOrderGuardConfigBuilder {
  private maxBlockAge = 100;
  private orderBufferMs = 30_000;

  maxBlockAge(value: number): this {
    this.maxBlockAge = value;
    return this;
  }

  orderBufferMs(value: number): this {
    this.orderBufferMs = value;
    return this;
  }

  build(): EventOrderGuard {
    return new EventOrderGuard({ maxBlockAge: this.maxBlockAge, orderBufferMs: this.orderBufferMs });
  }
}
