/**
 * Where the two keys meet.
 *
 * The governor runs first and its refusals are final: a proposal it blocks
 * never reaches the chain, never costs a fee, and never asks anyone for a
 * signature. Only a proposal it routes to `auto` is offered to the chain, and
 * the chain may still refuse it — that refusal is recorded with the same
 * weight and in the same ledger.
 *
 * The ordering is the argument. An on-chain cap alone stops a runaway agent
 * but not a wrong one; the governor stops the wrong one before it costs
 * anything. Governance alone is only as good as the process holding the keys;
 * the chain stops that one. Neither is asked to trust the other.
 */

import { toMinor } from "./governor/money";
import { route } from "./governor/route";
import type { Decision, RouteInput } from "./governor/types";
import type { Ledger, LedgerEntry } from "./ledger";

/** What the agent does when the governor allows it. Usually `x402.fetch`. */
export interface PaymentAttempt {
  (): Promise<{ paid: boolean; settlement?: { transaction: string } }>;
}

export type Outcome =
  /** The governor refused. Nothing was signed and nothing was spent. */
  | { kind: "refused-off-chain"; decision: Decision; entries: LedgerEntry[] }
  /** Legitimate but needs a person. Held, not refused. */
  | { kind: "held-for-approval"; decision: Decision; entries: LedgerEntry[] }
  /** The governor allowed it and the chain settled it. */
  | { kind: "settled"; decision: Decision; transaction: string; entries: LedgerEntry[] }
  /** The governor allowed it and the chain refused. The second key turning. */
  | { kind: "refused-on-chain"; decision: Decision; reason: string; entries: LedgerEntry[] };

export interface BridgeDeps {
  ledger: Ledger;
}

export async function execute(
  deps: BridgeDeps,
  input: RouteInput,
  pay: PaymentAttempt,
): Promise<Outcome> {
  const decision = route(input);

  const record = (
    authority: "governor" | "chain",
    lane: Decision["lane"],
    reasons: Decision["reasons"],
    transaction?: string,
  ): LedgerEntry =>
    deps.ledger.append({
      authority,
      proposalId: decision.proposalId,
      lane,
      reasons,
      amountMinor: decision.totalMinor,
      currency: decision.currency,
      ...(transaction ? { transaction } : {}),
    });

  const governorEntry = record("governor", decision.lane, decision.reasons);

  if (decision.lane === "blocked") {
    return { kind: "refused-off-chain", decision, entries: [governorEntry] };
  }

  if (decision.lane === "approval") {
    return { kind: "held-for-approval", decision, entries: [governorEntry] };
  }

  // The governor said yes. Now ask the chain.
  try {
    const result = await pay();
    const transaction = result.settlement?.transaction;

    if (!result.paid || !transaction) {
      const entry = record("chain", "blocked", [
        {
          code: "no_mandate_match",
          detail: "the resource did not require payment, or settlement carried no transaction",
        },
      ]);
      return {
        kind: "refused-on-chain",
        decision,
        reason: "no settlement was returned",
        entries: [governorEntry, entry],
      };
    }

    const entry = record("chain", "auto", decision.reasons, transaction);
    return { kind: "settled", decision, transaction, entries: [governorEntry, entry] };
  } catch (error) {
    // The chain declined a spend the governor had approved. This is the system
    // working, not failing, so it is recorded rather than thrown onward.
    const reason = error instanceof Error ? error.message : String(error);
    const entry = record("chain", "blocked", [
      { code: "over_agent_cap", detail: reason },
    ]);
    return { kind: "refused-on-chain", decision, reason, entries: [governorEntry, entry] };
  }
}

/** Convenience for demos: minor units for a decimal string. */
export const minor = toMinor;
