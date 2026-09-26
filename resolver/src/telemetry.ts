import type { Logger } from "pino";
import type { Supervisor, SupervisorState } from "./supervisor.js";
import {
  listenerLastEventTimestampSeconds,
  operationFailuresTotal,
  retryAttemptsTotal,
  activeOperations,
  resolverRuntimeStateInfo,
} from "./metrics.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Coarse-grained resolver runtime telemetry state, distinct from
 * `SupervisorState`: the supervisor describes its own restart lifecycle,
 * while this describes whether the resolver is actually fulfilling its
 * role from an operator's point of view.
 *
 * ### State definitions and threshold criteria
 *
 * | State      | Criteria                                                                       |
 * |------------|--------------------------------------------------------------------------------|
 * | CONNECTED  | Supervisor is running, all monitored chains have emitted an event within       |
 * |            | `staleAfterSeconds` (default 300 s), and recent failures are below the         |
 * |            | `degradedFailureThreshold` (default 3).                                        |
 * | DEGRADED   | Supervisor is running or actively restarting AND one of the following is true: |
 * |            | (a) supervisor is in `restarting` state; OR                                    |
 * |            | (b) `recentFailureCount >= degradedFailureThreshold`; OR                       |
 * |            | (c) `consecutiveRpcErrors >= consecutiveRpcErrorThreshold` (default 3).        |
 * | STALE      | Supervisor is running but one or more chains have not emitted an event for     |
 * |            | longer than `staleAfterSeconds`. Chain is considered stale before degraded     |
 * |            | because a quiet chain is a weaker operational signal than active failures.     |
 * | INACTIVE   | Supervisor is in `idle`, `stopping`, `stopped`, or `failed` state — the       |
 * |            | resolver is not performing any work at all.                                    |
 *
 * ### Precedence (strongest signal first)
 * INACTIVE > DEGRADED > STALE > CONNECTED
 *
 * INACTIVE is the clearest problem (the process isn't running). DEGRADED
 * (active failures/restarts) is stronger than STALE (just quiet) because a
 * chain can be genuinely quiet without any fault.
 */
export type ResolverTelemetryState = "connected" | "degraded" | "stale" | "inactive";

export const RESOLVER_TELEMETRY_STATES: readonly ResolverTelemetryState[] = [
  "connected",
  "degraded",
  "stale",
  "inactive",
];

/** Supervisor states that mean "not actually doing the resolver's job right now". */
const INACTIVE_SUPERVISOR_STATES: readonly SupervisorState[] = [
  "idle",
  "stopping",
  "stopped",
  "failed",
];

export interface ChainTelemetry {
  chain: string;
  /** Seconds since the last observed event on this chain, or null if none yet. */
  secondsSinceLastEvent: number | null;
  /** True when the chain has reported an event within the staleness window. */
  live: boolean;
}

export interface ResolverTelemetrySnapshot {
  state: ResolverTelemetryState;
  /** Short human-readable explanation of why `state` was chosen. */
  reason: string;
  supervisorState: SupervisorState;
  restarts: number;
  commandQueueDepth: number;
  recentFailureCount: number;
  recentRetryCount: number;
  consecutiveRpcErrors: number;
  chains: ChainTelemetry[];
}

export interface ComputeTelemetryInput {
  supervisorState: SupervisorState;
  restarts: number;
  nowSeconds: number;
  chainLastEventSeconds: Array<{ chain: string; lastEventSeconds: number | null }>;
  /** A chain is considered stale once this many seconds pass with no event. */
  staleAfterSeconds: number;
  /** Failures observed since the last telemetry collection. */
  recentFailureCount: number;
  /** Retry attempts observed since the last telemetry collection. */
  recentRetryCount: number;
  commandQueueDepth: number;
  /** recentFailureCount at or above this trips "degraded". Default: 3. */
  degradedFailureThreshold: number;
  /**
   * Number of consecutive RPC errors observed since the last successful
   * poll.  At or above `consecutiveRpcErrorThreshold` the state is
   * classified as "degraded" even when no chain has gone stale yet.
   * Default: 0 (not tracked by callers that don't have this data).
   */
  consecutiveRpcErrors: number;
  /**
   * Threshold for `consecutiveRpcErrors` to trip "degraded". Default: 3.
   */
  consecutiveRpcErrorThreshold: number;
}

// ── Pure computation ──────────────────────────────────────────────────────────

/**
 * Derive a single telemetry snapshot from already-gathered inputs. Kept pure
 * (no clock reads, no metrics registry access) so state-transition logic can
 * be tested deterministically.
 *
 * ### Precedence when multiple conditions hold:
 * inactive > degraded > stale > connected
 *
 * A resolver that isn't running at all (INACTIVE) is the strongest signal.
 * Active failures/restarts (DEGRADED) are stronger than a quiet chain (STALE)
 * because degraded implies active problems even if events are still arriving.
 * A resolver with no recent events but no active errors is STALE.
 * Everything healthy is CONNECTED.
 */
export function computeResolverTelemetry(input: ComputeTelemetryInput): ResolverTelemetrySnapshot {
  const {
    supervisorState,
    restarts,
    nowSeconds,
    chainLastEventSeconds,
    staleAfterSeconds,
    recentFailureCount,
    recentRetryCount,
    commandQueueDepth,
    degradedFailureThreshold,
    consecutiveRpcErrors,
    consecutiveRpcErrorThreshold,
  } = input;

  const chains: ChainTelemetry[] = chainLastEventSeconds.map(({ chain, lastEventSeconds }) => {
    if (lastEventSeconds === null) {
      return { chain, secondsSinceLastEvent: null, live: false };
    }
    const secondsSinceLastEvent = Math.max(0, nowSeconds - lastEventSeconds);
    return { chain, secondsSinceLastEvent, live: secondsSinceLastEvent <= staleAfterSeconds };
  });

  const base = {
    supervisorState,
    restarts,
    commandQueueDepth,
    recentFailureCount,
    recentRetryCount,
    consecutiveRpcErrors,
    chains,
  };

  // ── INACTIVE: supervisor is not running ───────────────────────────────────
  if (INACTIVE_SUPERVISOR_STATES.includes(supervisorState)) {
    return {
      ...base,
      state: "inactive",
      reason: `supervisor is ${supervisorState}`,
    };
  }

  // ── DEGRADED: active failures or consecutive RPC errors ───────────────────
  // Check degraded before stale: active errors are a stronger signal than
  // a temporarily quiet chain.
  if (supervisorState === "restarting") {
    return {
      ...base,
      state: "degraded",
      reason: `supervisor is restarting (restart ${restarts})`,
    };
  }

  if (recentFailureCount >= degradedFailureThreshold) {
    return {
      ...base,
      state: "degraded",
      reason: `elevated failure count since last check (${recentFailureCount} >= threshold ${degradedFailureThreshold})`,
    };
  }

  if (consecutiveRpcErrors >= consecutiveRpcErrorThreshold) {
    return {
      ...base,
      state: "degraded",
      reason: `consecutive RPC errors (${consecutiveRpcErrors} >= threshold ${consecutiveRpcErrorThreshold})`,
    };
  }

  // ── STALE: chain(s) have gone quiet ───────────────────────────────────────
  const staleChains = chains.filter((c) => !c.live);
  if (staleChains.length > 0) {
    const details = staleChains.map((c) =>
      c.secondsSinceLastEvent !== null
        ? `${c.chain} (${c.secondsSinceLastEvent}s ago, threshold ${staleAfterSeconds}s)`
        : `${c.chain} (no events yet)`
    );
    return {
      ...base,
      state: "stale",
      reason: `no recent events from: ${details.join("; ")}`,
    };
  }

  // ── CONNECTED: all checks pass ────────────────────────────────────────────
  return {
    ...base,
    state: "connected",
    reason: "all chains live, no elevated failures or RPC errors",
  };
}

// ── Metrics-backed collection ─────────────────────────────────────────────────

export interface CollectTelemetryDeps {
  supervisor: Supervisor;
  /** Chains to report liveness for, e.g. ["ethereum", "soroban"]. */
  chains: string[];
  /** Defaults to 300s (5 minutes). */
  staleAfterSeconds?: number;
  /** Defaults to 3. */
  degradedFailureThreshold?: number;
  /** Defaults to 3. */
  consecutiveRpcErrorThreshold?: number;
  /** Optional logger for state-transition log lines. */
  log?: Logger;
}

/**
 * Tracks cumulative counter totals across calls so `recentFailureCount` /
 * `recentRetryCount` reflect activity since the *last* collection rather
 * than an ever-growing total that would eventually trip "degraded"
 * permanently on any long-lived process.
 *
 * Also tracks state transitions and emits log lines on every change so
 * operators can see exactly when and why the resolver's liveness state
 * changed without having to correlate metrics dashboards.
 */
export class ResolverTelemetryCollector {
  private lastFailureTotal = 0;
  private lastRetryTotal = 0;
  private lastState: ResolverTelemetryState | null = null;

  async collect(deps: CollectTelemetryDeps): Promise<ResolverTelemetrySnapshot> {
    const staleAfterSeconds = deps.staleAfterSeconds ?? 300;
    const degradedFailureThreshold = deps.degradedFailureThreshold ?? 3;
    const consecutiveRpcErrorThreshold = deps.consecutiveRpcErrorThreshold ?? 3;
    const nowSeconds = Math.floor(Date.now() / 1000);

    const [lastEventMetric, failuresMetric, retriesMetric, activeOpsMetric] = await Promise.all([
      listenerLastEventTimestampSeconds.get(),
      operationFailuresTotal.get(),
      retryAttemptsTotal.get(),
      activeOperations.get(),
    ]);

    const chainLastEventSeconds = deps.chains.map((chain) => {
      const match = lastEventMetric.values.find((v) => v.labels.chain === chain);
      return { chain, lastEventSeconds: match ? match.value : null };
    });

    const failureTotal = sumValues(failuresMetric.values);
    const retryTotal = sumValues(retriesMetric.values);
    const commandQueueDepth = sumValues(activeOpsMetric.values);

    const recentFailureCount = Math.max(0, failureTotal - this.lastFailureTotal);
    const recentRetryCount = Math.max(0, retryTotal - this.lastRetryTotal);
    this.lastFailureTotal = failureTotal;
    this.lastRetryTotal = retryTotal;

    const snapshot = computeResolverTelemetry({
      supervisorState: deps.supervisor.state,
      restarts: deps.supervisor.restarts,
      nowSeconds,
      chainLastEventSeconds,
      staleAfterSeconds,
      recentFailureCount,
      recentRetryCount,
      commandQueueDepth,
      degradedFailureThreshold,
      // The metrics-backed collector does not currently track consecutive RPC
      // errors independently (that would require a dedicated counter).  Pass 0
      // so the threshold is never tripped from this path; callers that have
      // access to per-chain error counts can use computeResolverTelemetry()
      // directly with the real value.
      consecutiveRpcErrors: 0,
      consecutiveRpcErrorThreshold,
    });

    publishResolverTelemetryMetric(snapshot.state);

    // ── State-transition logging ──────────────────────────────────────────
    if (snapshot.state !== this.lastState) {
      if (deps.log) {
        const level = stateLogLevel(snapshot.state);
        deps.log[level](
          {
            previousState: this.lastState ?? "unknown",
            newState: snapshot.state,
            reason: snapshot.reason,
            supervisorState: snapshot.supervisorState,
            restarts: snapshot.restarts,
            recentFailureCount: snapshot.recentFailureCount,
            consecutiveRpcErrors: snapshot.consecutiveRpcErrors,
            chains: snapshot.chains,
          },
          `resolver liveness state transition: ${this.lastState ?? "unknown"} → ${snapshot.state}`,
        );
      }
      this.lastState = snapshot.state;
    }

    return snapshot;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sumValues(values: Array<{ value: number }>): number {
  return values.reduce((sum, v) => sum + v.value, 0);
}

/** Set the `resolver_runtime_state_info` gauge so only the current state reads 1. */
function publishResolverTelemetryMetric(state: ResolverTelemetryState): void {
  for (const candidate of RESOLVER_TELEMETRY_STATES) {
    resolverRuntimeStateInfo.set({ state: candidate }, candidate === state ? 1 : 0);
  }
}

/**
 * Map a telemetry state to the appropriate log level.
 *
 * - CONNECTED  → info  (normal operation, worth noting on first transition)
 * - STALE      → warn  (chain has gone quiet; investigate but not urgent)
 * - DEGRADED   → warn  (active errors or restarts; needs attention)
 * - INACTIVE   → error (resolver has stopped entirely)
 */
function stateLogLevel(state: ResolverTelemetryState): "info" | "warn" | "error" {
  switch (state) {
    case "connected":
      return "info";
    case "stale":
      return "warn";
    case "degraded":
      return "warn";
    case "inactive":
      return "error";
  }
}
