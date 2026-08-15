/**
 * The facilitator: verify, then settle.
 *
 * A resource server never talks to the chain itself. It hands the inbound
 * `PAYMENT-SIGNATURE` here, gets a yes or no, and on yes gets a transaction
 * hash back. Everything expensive or trust-bearing happens in this file.
 *
 * The reason this is self-hosted rather than a hosted endpoint is one number.
 * A Vellar payment runs its policy contracts inside the smart wallet's
 * `__check_auth`, which costs materially more resource fee than a plain SEP-41
 * transfer. Hosted facilitators cap the fee they will sponsor — x402.org's
 * default is 50,000 stroops — so a policy-governed payment is refused there
 * every time. Since policy-governed payments are the entire premise here, the
 * ceiling is configuration, and it is enforced explicitly rather than left to
 * whatever the network happens to quote.
 */

import {
  ProtocolError,
  decodePaymentSignature,
  notSettled,
  settled,
  type Caip2,
  type PaymentRequirements,
  type PaymentSignature,
  type SettleResponse,
} from "./protocol";

/** x402.org's default sponsored-fee ceiling. Too low for a policy-governed payment. */
export const HOSTED_DEFAULT_MAX_FEE_STROOPS = 50_000;

/**
 * What the facilitator needs from the chain. Two operations, both on an
 * envelope it did not build, so neither may mutate it: the auth entry is
 * signed and the signature covers exactly these bytes.
 */
export interface Settler {
  /**
   * Re-simulate the submitted envelope. Returns the resource fee the network
   * will charge, and whether the invocation succeeds — a policy that refuses
   * inside `__check_auth` fails here, before any fee is spent.
   */
  simulate(input: { transactionXdr: string; network: Caip2 }): Promise<SimulationOutcome>;
  /** Submit and wait for the network hash. */
  submit(input: { transactionXdr: string; network: Caip2 }): Promise<{ hash: string }>;
}

export interface SimulationOutcome {
  /** False when the invocation itself fails — including a policy refusal. */
  success: boolean;
  /** Resource fee in stroops, as quoted by simulation. */
  feeStroops: number;
  /** Present when `success` is false. Surfaced verbatim to the payer. */
  error?: string;
}

export interface VerifyResult {
  isValid: boolean;
  /** Present when `isValid` is false. Becomes the 402's `error` field. */
  invalidReason?: string;
  /** The fee simulation quoted, when it got that far. */
  feeStroops?: number;
}

export interface FacilitatorOptions {
  settler: Settler;
  /** The network this facilitator serves. An offer for any other is refused. */
  network: Caip2;
  /**
   * Sponsored-fee ceiling in stroops. Defaults an order of magnitude above the
   * hosted default, because the hosted default cannot pay for a policy check.
   */
  maxFeeStroops?: number;
}

export interface Facilitator {
  /** Structural and economic checks. No submission, nothing spent. */
  verify(header: string, expected?: Partial<PaymentRequirements>): Promise<VerifyResult>;
  /** Verify, then submit. Refuses without submitting if verification fails. */
  settle(header: string, expected?: Partial<PaymentRequirements>): Promise<SettleResponse>;
  /** What this facilitator will sponsor, for the /supported endpoint. */
  capabilities(): { network: Caip2; scheme: "exact"; maxFeeStroops: number };
}

export const DEFAULT_MAX_FEE_STROOPS = 500_000;

export function createFacilitator(options: FacilitatorOptions): Facilitator {
  const { settler, network } = options;
  const maxFeeStroops = options.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;

  if (!Number.isInteger(maxFeeStroops) || maxFeeStroops <= 0) {
    throw new Error(`maxFeeStroops must be a positive integer, got ${maxFeeStroops}`);
  }

  /** Decode + structural check, folded into a VerifyResult rather than thrown. */
  function parse(header: string): { payment: PaymentSignature } | { reason: string } {
    try {
      return { payment: decodePaymentSignature(header) };
    } catch (error) {
      if (error instanceof ProtocolError) return { reason: error.reason };
      throw error;
    }
  }

  /**
   * Compares the offer the payer signed against the offer we actually made.
   * Without this a payer could sign a self-authored requirement — paying one
   * stroop to an address of their choosing — and the transfer would verify
   * perfectly well on its own terms.
   */
  function matchesExpected(
    accepted: PaymentRequirements,
    expected: Partial<PaymentRequirements> | undefined,
  ): string | undefined {
    if (!expected) return undefined;
    for (const field of ["asset", "payTo", "amount", "network"] as const) {
      const want = expected[field];
      if (want !== undefined && accepted[field] !== want) {
        return `${field} does not match the offer: expected ${String(want)}, got ${String(accepted[field])}`;
      }
    }
    return undefined;
  }

  async function verify(
    header: string,
    expected?: Partial<PaymentRequirements>,
  ): Promise<VerifyResult> {
    const parsed = parse(header);
    if ("reason" in parsed) {
      return { isValid: false, invalidReason: parsed.reason };
    }

    const { accepted, payload } = parsed.payment;

    if (accepted.network !== network) {
      return {
        isValid: false,
        invalidReason: `this facilitator settles ${network}, the payment is for ${accepted.network}`,
      };
    }

    const mismatch = matchesExpected(accepted, expected);
    if (mismatch) {
      return { isValid: false, invalidReason: mismatch };
    }

    const simulation = await settler.simulate({
      transactionXdr: payload.transaction,
      network,
    });

    // A policy refusing inside __check_auth lands here — the payment is
    // well-formed and the chain still says no. That is the on-chain key
    // declining to turn, and it is reported as such rather than as a fault.
    if (!simulation.success) {
      return {
        isValid: false,
        invalidReason: simulation.error ?? "simulation failed",
        feeStroops: simulation.feeStroops,
      };
    }

    if (simulation.feeStroops > maxFeeStroops) {
      return {
        isValid: false,
        feeStroops: simulation.feeStroops,
        invalidReason:
          `resource fee ${simulation.feeStroops} stroops exceeds this facilitator's ceiling of ` +
          `${maxFeeStroops}. A policy-governed payment costs more than a plain transfer; raise ` +
          `FACILITATOR_MAX_FEE_STROOPS.`,
      };
    }

    return { isValid: true, feeStroops: simulation.feeStroops };
  }

  async function settle(
    header: string,
    expected?: Partial<PaymentRequirements>,
  ): Promise<SettleResponse> {
    const verified = await verify(header, expected);
    if (!verified.isValid) {
      // No transaction hash, deliberately: the client reads success:false with
      // no hash as "not spent", and the same shape with a hash as "fees were
      // charged". Nothing has been submitted, so it must be the former.
      return notSettled(verified.invalidReason ?? "verification failed");
    }

    const parsed = parse(header);
    if ("reason" in parsed) {
      return notSettled(parsed.reason);
    }

    try {
      const { hash } = await settler.submit({
        transactionXdr: parsed.payment.payload.transaction,
        network,
      });
      return settled(hash, parsed.payment.accepted.payTo);
    } catch (error) {
      // Submission threw after verification passed. We cannot claim the money
      // did not move — the envelope may have reached the network — so this is
      // reported without a hash but named as a submission failure rather than
      // a refusal.
      const detail = error instanceof Error ? error.message : String(error);
      return notSettled(`submission failed after verification: ${detail}`);
    }
  }

  return {
    verify,
    settle,
    capabilities: () => ({ network, scheme: "exact", maxFeeStroops }),
  };
}
