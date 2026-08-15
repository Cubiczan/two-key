/**
 * Policy templates, definition validation, and the deployment seam.
 *
 * Two of the six policy routes are fully ours to answer — `templates` and
 * `validate` are statements about what this gateway accepts, and nothing
 * on-chain is required to answer them. The other four mint or attach a real
 * per-user contract instance, which needs the policy WASM and a funded sponsor,
 * so they run through `PolicyDeployer` and refuse with a typed 503 until that
 * is wired.
 *
 * Validating early matters more here than it looks. A malformed spending limit
 * that reaches the chain becomes a policy contract that is wrong forever at a
 * known address, and the user has already paid a passkey prompt for it.
 */

import { NotConfiguredError, type Network, type PolicyDefinition, type PolicyTemplate } from "./types";

/**
 * The templates vellar-sdk 0.6.0 documents. Deliberately a closed set: an
 * unrecognised `type` is refused rather than passed through, because "the
 * gateway accepted it" is indistinguishable from "the chain will enforce it"
 * from the caller's side.
 */
export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
  {
    type: "spending_limit",
    title: "Spending limit",
    description: "A cumulative cap on how much a signer can move per fixed window.",
    onChainEnforcement: "Enforced inside the smart wallet's __check_auth on every transfer the key signs.",
  },
  {
    type: "verified_only",
    title: "Verified only (provenance)",
    description: "Restricts payments to contracts whose source is reproducibly verified.",
    onChainEnforcement: "Enforced inside __check_auth by comparing the invoked contract against the verified set.",
  },
];

const TEMPLATE_TYPES = new Set(POLICY_TEMPLATES.map((t) => t.type));

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/** Stellar addresses: `G…` classic accounts and `C…` contracts, 56 chars. */
const ADDRESS = /^[GC][A-Z2-7]{55}$/;

/** A positive decimal amount, e.g. "100" or "12.50". Rejects "", "-1", "1e3". */
const DECIMAL = /^\d+(\.\d+)?$/;

export function validateDefinition(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { valid: false, errors: ["definition must be an object"] };
  }

  const def = input as Partial<PolicyDefinition>;

  if (def.version !== "1") {
    errors.push(`version must be "1", got ${JSON.stringify(def.version)}`);
  }

  if (typeof def.type !== "string" || !TEMPLATE_TYPES.has(def.type)) {
    errors.push(
      `type must be one of ${[...TEMPLATE_TYPES].join(", ")}, got ${JSON.stringify(def.type)}`,
    );
  }

  if (!Array.isArray(def.owners) || def.owners.length === 0) {
    errors.push("owners must be a non-empty array");
  } else {
    for (const owner of def.owners) {
      if (typeof owner !== "string" || !ADDRESS.test(owner)) {
        errors.push(`owner ${JSON.stringify(owner)} is not a Stellar address`);
      }
    }
  }

  // A spending-limit policy with no limit is the most dangerous shape here: it
  // reads as "capped" everywhere downstream while enforcing nothing.
  if (def.type === "spending_limit") {
    const limits = def.spendingLimits;
    if (typeof limits !== "object" || limits === null || Object.keys(limits).length === 0) {
      errors.push("spending_limit requires a non-empty spendingLimits object");
    } else {
      for (const [window, amount] of Object.entries(limits)) {
        if (typeof amount !== "string" || !DECIMAL.test(amount)) {
          errors.push(`spendingLimits.${window} must be a positive decimal string, got ${JSON.stringify(amount)}`);
        } else if (Number(amount) === 0) {
          errors.push(`spendingLimits.${window} must be greater than zero`);
        }
      }
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

// --- Deployment seam -----------------------------------------------------

export interface GeneratedPolicy {
  id: string;
  type: string;
  network: Network;
  definition: PolicyDefinition;
  /** Set once `recordDeployment` has been told the instance address. */
  contractId?: string;
  /** Set once the attach transaction is known. */
  txHash?: string;
}

export interface SimulationResult {
  ok: boolean;
  detail: string;
}

/**
 * Everything that needs the policy WASM, a funded sponsor, or the network.
 * Kept behind one interface so the routes are complete and testable now, and
 * wiring the real implementation is a single substitution later.
 */
export interface PolicyDeployer {
  generate(input: { definition: PolicyDefinition; network: Network }): Promise<GeneratedPolicy>;
  simulate(input: { policyId: string; wallet: string }): Promise<SimulationResult>;
  deployInstance(input: { policyId: string; wallet: string }): Promise<{ contractId: string }>;
  recordDeployment(input: {
    policyId: string;
    txHash: string;
    contractId: string;
  }): Promise<GeneratedPolicy>;
}

export function createUnconfiguredPolicyDeployer(): PolicyDeployer {
  const refuse = (): never => {
    throw new NotConfiguredError("Policy deployment (policy WASM hash and sponsor account)");
  };
  return {
    async generate() {
      return refuse();
    },
    async simulate() {
      return refuse();
    },
    async deployInstance() {
      return refuse();
    },
    async recordDeployment() {
      return refuse();
    },
  };
}
