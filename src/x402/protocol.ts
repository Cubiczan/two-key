/**
 * The x402 wire, as vellar-sdk 0.6.0 speaks it.
 *
 * Three base64url-of-JSON headers carry the whole exchange:
 *
 *   402 response   PAYMENT-REQUIRED    { accepts: PaymentRequirements[], error? }
 *   paid request   PAYMENT-SIGNATURE   { x402Version: 2, accepted, payload: { transaction } }
 *   paid response  X-PAYMENT-RESPONSE  { success, transaction, payer?, errorReason? }
 *
 * Transcribed from the SDK's own encoder/decoder rather than from the x402
 * prose, because three of these rules are invisible in the prose and each one
 * turns into a refusal the client reports as something else:
 *
 *   1. `network` is CAIP-2 (`stellar:testnet` / `stellar:pubnet`), not the
 *      SDK's own `"testnet"`. A mismatch reads as "no usable payment option".
 *   2. Every offer must declare `extra.areFeesSponsored === true`. The client
 *      filters on it and refuses the lot if none declares it — an omitted flag
 *      is treated exactly like an explicit `false`.
 *   3. `amount` is an integer string in the asset's base units. `"1.5"` is
 *      refused by `parseAmount` before any network call happens.
 */

export type Caip2 = "stellar:testnet" | "stellar:pubnet";

export const CAIP2_BY_NETWORK = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
} as const satisfies Record<string, Caip2>;

export const PASSPHRASE_BY_CAIP2: Record<Caip2, string> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

/** One payment option offered in a 402 challenge. */
export interface PaymentRequirements {
  /** Only "exact" is implemented by the SDK's client. */
  scheme: "exact";
  network: Caip2;
  /** SEP-41 token contract the transfer must call. */
  asset: string;
  /** Integer string, base units. Never a decimal. */
  amount: string;
  /** Recipient. */
  payTo: string;
  /** Bounds the signature-expiration window the client derives. */
  maxTimeoutSeconds?: number;
  extra: {
    /**
     * Must be `true`. The client's `selectRequirements` drops every offer that
     * does not say so, then reports "did not declare areFeesSponsored=true".
     */
    areFeesSponsored: true;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PaymentRequiredBody {
  accepts: PaymentRequirements[];
  /** Read by `extractRejectionReason` when a payment is refused. */
  error?: string;
}

export interface PaymentSignature {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: { transaction: string };
}

export interface SettleResponse {
  success: boolean;
  /** 64-hex. Anything else is classified "indeterminate" by the client. */
  transaction?: string;
  payer?: string;
  errorReason?: string;
}

export class ProtocolError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "ProtocolError";
    this.reason = reason;
  }
}

const INTEGER = /^\d+$/;
const TRANSACTION_HASH = /^[0-9a-f]{64}$/i;
const ADDRESS = /^[GC][A-Z2-7]{55}$/;

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(header: string): T {
  let text: string;
  try {
    text = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new ProtocolError("header is not valid base64");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProtocolError("header is not valid JSON");
  }
}

/**
 * Builds a 402 challenge. Every offer is checked here rather than trusted,
 * because an offer the client silently drops produces a
 * `NoUsablePaymentOptionError` on the agent side that says nothing about which
 * field was wrong.
 */
export function paymentRequired(accepts: PaymentRequirements[], error?: string): PaymentRequiredBody {
  if (accepts.length === 0) {
    throw new ProtocolError("a 402 challenge must offer at least one payment option");
  }
  for (const offer of accepts) {
    assertOffer(offer);
  }
  return error === undefined ? { accepts } : { accepts, error };
}

export function assertOffer(offer: PaymentRequirements): void {
  if (offer.scheme !== "exact") {
    throw new ProtocolError(`scheme must be "exact", got ${JSON.stringify(offer.scheme)}`);
  }
  if (!(offer.network in PASSPHRASE_BY_CAIP2)) {
    throw new ProtocolError(
      `network must be CAIP-2 (stellar:testnet or stellar:pubnet), got ${JSON.stringify(offer.network)}`,
    );
  }
  if (!INTEGER.test(offer.amount)) {
    throw new ProtocolError(
      `amount must be an integer string in base units, got ${JSON.stringify(offer.amount)}`,
    );
  }
  if (offer.amount === "0") {
    throw new ProtocolError("amount must be greater than zero");
  }
  if (!ADDRESS.test(offer.asset)) {
    throw new ProtocolError(`asset must be a contract address, got ${JSON.stringify(offer.asset)}`);
  }
  if (!ADDRESS.test(offer.payTo)) {
    throw new ProtocolError(`payTo must be a Stellar address, got ${JSON.stringify(offer.payTo)}`);
  }
  // The single most consequential field, and the easiest to leave out.
  if (offer.extra?.areFeesSponsored !== true) {
    throw new ProtocolError(
      "extra.areFeesSponsored must be true — the client drops every offer that does not declare it",
    );
  }
}

/** Parses and structurally checks an inbound `PAYMENT-SIGNATURE`. */
export function decodePaymentSignature(header: string): PaymentSignature {
  const decoded = decodeHeader<Partial<PaymentSignature>>(header);

  if (decoded.x402Version !== 2) {
    throw new ProtocolError(`unsupported x402Version ${JSON.stringify(decoded.x402Version)}`);
  }
  if (typeof decoded.payload?.transaction !== "string" || decoded.payload.transaction.length === 0) {
    throw new ProtocolError("payload.transaction must be a transaction envelope");
  }
  if (!decoded.accepted) {
    throw new ProtocolError("accepted requirements are missing");
  }
  assertOffer(decoded.accepted);

  return decoded as PaymentSignature;
}

/**
 * A settlement the client will read as settled. Guarded because the client
 * classifies a success carrying a malformed hash as *indeterminate* — the
 * worst outcome available, since it means "we cannot tell you whether your
 * money moved".
 */
export function settled(transaction: string, payer?: string): SettleResponse {
  if (!TRANSACTION_HASH.test(transaction)) {
    throw new ProtocolError(
      `settlement hash must be 64 hex characters, got ${JSON.stringify(transaction)}`,
    );
  }
  return payer === undefined
    ? { success: true, transaction }
    : { success: true, transaction, payer };
}

/**
 * A refusal that happened *before* submission, so the caller learns its money
 * did not move. Deliberately carries no `transaction`: the client reads
 * `success:false` with no hash as "not-spent", and the same field set with a
 * hash as "fees were charged".
 */
export function notSettled(errorReason: string): SettleResponse {
  return { success: false, errorReason };
}
