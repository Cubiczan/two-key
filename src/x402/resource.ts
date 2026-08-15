/**
 * The paywall a resource server puts in front of a paid endpoint.
 *
 * It owns the offer and nothing else: no chain access, no keys. Given the
 * inbound `PAYMENT-SIGNATURE` it asks the facilitator, and turns the answer
 * into the exact headers the SDK client reads.
 *
 * The offer it made is passed to the facilitator as `expected`, which is what
 * stops a payer signing a requirement of their own invention.
 */

import { createFacilitator, type Facilitator } from "./facilitator";
import {
  encodeHeader,
  paymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "./protocol";

export interface PaywallOptions {
  facilitator: Facilitator;
  /** The single offer this endpoint makes. */
  price: PaymentRequirements;
}

export type GateResult =
  | { allowed: true; status: 200; headers: Record<string, string>; settlement: SettleResponse }
  | { allowed: false; status: 402; headers: Record<string, string>; reason?: string };

export interface Paywall {
  /** The offer, for callers that want to advertise it out of band. */
  readonly price: PaymentRequirements;
  /** Decide whether this request may through. Settles when it may. */
  gate(paymentSignature: string | undefined): Promise<GateResult>;
}

export function createPaywall(options: PaywallOptions): Paywall {
  const { facilitator, price } = options;

  // Validated once, at construction: an offer the client would silently drop
  // should fail here, not on every request.
  const challenge = paymentRequired([price]);

  function refuse(reason?: string): GateResult {
    return {
      allowed: false,
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodeHeader(
          reason ? { ...challenge, error: reason } : challenge,
        ),
      },
      ...(reason ? { reason } : {}),
    };
  }

  return {
    price,

    async gate(paymentSignature) {
      // No payment yet: this is the ordinary first request, not a failure.
      if (!paymentSignature) {
        return refuse();
      }

      const settlement = await facilitator.settle(paymentSignature, {
        asset: price.asset,
        payTo: price.payTo,
        amount: price.amount,
        network: price.network,
      });

      if (!settlement.success) {
        // The reason rides back in PAYMENT-REQUIRED.error, which is where
        // `extractRejectionReason` looks. Without it the payer gets a bare
        // "payment was not accepted" and no way to tell an over-budget
        // refusal from a malformed one.
        return refuse(settlement.errorReason ?? "payment was not accepted");
      }

      return {
        allowed: true,
        status: 200,
        headers: { "X-PAYMENT-RESPONSE": encodeHeader(settlement) },
        settlement,
      };
    },
  };
}

/** Convenience for the common case: one price, one facilitator, default ceiling. */
export function createSimplePaywall(input: {
  price: PaymentRequirements;
  settler: Parameters<typeof createFacilitator>[0]["settler"];
  maxFeeStroops?: number;
}): Paywall {
  return createPaywall({
    price: input.price,
    facilitator: createFacilitator({
      settler: input.settler,
      network: input.price.network,
      ...(input.maxFeeStroops === undefined ? {} : { maxFeeStroops: input.maxFeeStroops }),
    }),
  });
}
