/**
 * The gateway's contract with `vellar-sdk`.
 *
 * These shapes are not ours to choose. They are transcribed from the SDK's own
 * HTTP clients (`createHttpWalletBackend` and `createPolicyClient` in
 * vellar-sdk@0.6.0), because a gateway that almost matches is a gateway that
 * fails at the passkey prompt with nothing useful in the log.
 *
 * Wire summary — wallet routes:
 *   POST /wallet/create   { keyId, contractId, network, signedTx } -> { sessionId }
 *   POST /wallet/connect  { keyId, network }                       -> { contractId, sessionId } | 404
 *   POST /wallet/submit   { signedXdr, network }                   -> { hash }
 *
 * Wire summary — policy routes:
 *   GET  /policies/templates                                       -> { templates }
 *   POST /policies/validate           <definition>                 -> { valid, errors? }
 *   POST /policies/generate           { definition, network }      -> { policy }
 *   POST /policies/:id/simulate       { wallet }                   -> { ok, … }
 *   POST /policies/:id/deploy-instance{ wallet }                   -> { contractId }
 *   POST /policies/deploy             { policyId, txHash, contractId } -> { policy }
 */

/** The networks the SDK will hand us. Anything else is refused at the door. */
export type Network = "testnet" | "mainnet";

export const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

// --- Wallet routes -------------------------------------------------------

export interface WalletCreateRequest {
  keyId: string;
  contractId: string;
  network: Network;
  /** Already converted to XDR by the SDK's `defaultSignedToXdr`. */
  signedTx: string;
}

export interface WalletCreateResponse {
  sessionId: string;
}

export interface WalletConnectRequest {
  keyId: string;
  network: Network;
}

export interface WalletConnectResponse {
  contractId: string;
  sessionId: string;
}

export interface WalletSubmitRequest {
  signedXdr: string;
  network: Network;
}

export interface WalletSubmitResponse {
  hash: string;
}

// --- Policy routes -------------------------------------------------------

/**
 * A policy definition as the SDK sends it. `type` is open on the wire but only
 * the two shipped templates are honoured — see `POLICY_TEMPLATES`.
 */
export interface PolicyDefinition {
  version: string;
  type: string;
  owners: string[];
  spendingLimits?: Record<string, string>;
  [key: string]: unknown;
}

export interface PolicyTemplate {
  type: string;
  title: string;
  description: string;
  /** What the chain actually enforces, in the template's own words. */
  onChainEnforcement: string;
}

// --- Errors --------------------------------------------------------------

/**
 * Both SDK clients read a failure body the same way: `payload.message ??
 * payload.error`, with `payload.error` kept as a machine-readable `code` and
 * `payload.errors` surfaced by the policy client as field errors. So every
 * refusal from this gateway carries all three.
 */
export interface ErrorBody {
  error: string;
  message: string;
  errors?: string[];
}

export class GatewayError extends Error {
  // Declared explicitly rather than as constructor parameter properties: the
  // test runner strips types without transforming, and that syntax needs a
  // transform.
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: string[];

  constructor(status: number, code: string, message: string, fieldErrors?: string[]) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  toBody(): ErrorBody {
    return this.fieldErrors
      ? { error: this.code, message: this.message, errors: this.fieldErrors }
      : { error: this.code, message: this.message };
  }
}

/**
 * Raised by a seam that exists but has not been given its credentials — a
 * relayer key, a sponsor account, a policy WASM hash. Distinct from a bad
 * request on purpose: 503 tells the caller to fix the deployment, 400 tells
 * them to fix their payload.
 */
export class NotConfiguredError extends GatewayError {
  constructor(what: string) {
    super(503, "not_configured", `${what} is not configured on this gateway`);
    this.name = "NotConfiguredError";
  }
}

/** The result of a routed call, before it is written to a socket. */
export interface RouteResult {
  status: number;
  body: unknown;
}
