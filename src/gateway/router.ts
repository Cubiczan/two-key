/**
 * The router: one pure function from (method, path, body) to a status and a
 * body. No sockets, no environment, no clock — so every route, including the
 * refusals, is characterizable in a test.
 *
 * The same deny-first discipline the spend governor uses applies here. Shape
 * checks run before anything is looked up, and a route reaches a store or a
 * network only after its payload has been established as well-formed.
 */

import {
  POLICY_TEMPLATES,
  validateDefinition,
  type PolicyDeployer,
} from "./policies";
import type { SessionStore } from "./store";
import type { Submitter } from "./submitter";
import {
  GatewayError,
  isNetwork,
  type Network,
  type PolicyDefinition,
  type RouteResult,
} from "./types";

export interface RouterDeps {
  sessions: SessionStore;
  submitter: Submitter;
  policies: PolicyDeployer;
}

export interface RouteRequest {
  method: string;
  /** Path only — query and origin are handled by the HTTP adapter. */
  path: string;
  /** Parsed JSON body, or undefined for bodyless requests. */
  body?: unknown;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GatewayError(400, "invalid_body", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new GatewayError(400, "invalid_request", `${field} must be a non-empty string`);
  }
  return value;
}

function requireNetwork(body: Record<string, unknown>): Network {
  const value = body.network;
  if (!isNetwork(value)) {
    throw new GatewayError(400, "invalid_request", `network must be "testnet" or "mainnet"`);
  }
  return value;
}

/** Strips a trailing slash so `/wallet/create/` and `/wallet/create` agree. */
function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export async function handle(deps: RouterDeps, req: RouteRequest): Promise<RouteResult> {
  const path = normalize(req.path);
  const method = req.method.toUpperCase();

  // --- Wallet -----------------------------------------------------------

  if (path === "/wallet/create") {
    requireMethod(method, "POST");
    const body = asObject(req.body);
    const session = await deps.sessions.create({
      keyId: requireString(body, "keyId"),
      contractId: requireString(body, "contractId"),
      network: requireNetwork(body),
    });
    // The SDK reads only sessionId here; the rest of the record is ours.
    return { status: 200, body: { sessionId: session.sessionId } };
  }

  if (path === "/wallet/connect") {
    requireMethod(method, "POST");
    const body = asObject(req.body);
    const found = await deps.sessions.lookup({
      keyId: requireString(body, "keyId"),
      network: requireNetwork(body),
    });
    // 404 is the SDK's documented "no wallet for this passkey" signal — it
    // maps to `undefined`, not to a thrown error, so it must not be a 4xx body
    // the client would surface as a failure.
    if (!found) {
      return { status: 404, body: { error: "not_found", message: "no wallet for this passkey on this network" } };
    }
    return { status: 200, body: { contractId: found.contractId, sessionId: found.sessionId } };
  }

  if (path === "/wallet/submit") {
    requireMethod(method, "POST");
    const body = asObject(req.body);
    const result = await deps.submitter.submit({
      signedXdr: requireString(body, "signedXdr"),
      network: requireNetwork(body),
    });
    return { status: 200, body: { hash: result.hash } };
  }

  // --- Policies ---------------------------------------------------------

  if (path === "/policies/templates") {
    requireMethod(method, "GET");
    return { status: 200, body: { templates: POLICY_TEMPLATES } };
  }

  if (path === "/policies/validate") {
    requireMethod(method, "POST");
    // The SDK posts the bare definition here, not a wrapper.
    const result = validateDefinition(req.body);
    return { status: 200, body: result };
  }

  if (path === "/policies/generate") {
    requireMethod(method, "POST");
    const body = asObject(req.body);
    const network = requireNetwork(body);
    const validation = validateDefinition(body.definition);
    if (!validation.valid) {
      throw new GatewayError(
        400,
        "invalid_definition",
        "policy definition is not valid",
        validation.errors,
      );
    }
    const policy = await deps.policies.generate({
      definition: body.definition as PolicyDefinition,
      network,
    });
    return { status: 200, body: { policy } };
  }

  if (path === "/policies/deploy") {
    requireMethod(method, "POST");
    const body = asObject(req.body);
    const policy = await deps.policies.recordDeployment({
      policyId: requireString(body, "policyId"),
      txHash: requireString(body, "txHash"),
      contractId: requireString(body, "contractId"),
    });
    return { status: 200, body: { policy } };
  }

  // `/policies/:id/simulate` and `/policies/:id/deploy-instance` are matched
  // last so the fixed paths above can never be captured as a policy id.
  const instance = /^\/policies\/([^/]+)\/(simulate|deploy-instance)$/.exec(path);
  if (instance) {
    requireMethod(method, "POST");
    const policyId = decodeURIComponent(instance[1]!);
    const action = instance[2]!;
    const body = asObject(req.body);
    const wallet = requireString(body, "wallet");

    if (action === "simulate") {
      const result = await deps.policies.simulate({ policyId, wallet });
      return { status: 200, body: result };
    }
    const result = await deps.policies.deployInstance({ policyId, wallet });
    return { status: 200, body: { contractId: result.contractId } };
  }

  throw new GatewayError(404, "unknown_route", `no route for ${method} ${path}`);
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new GatewayError(405, "method_not_allowed", `expected ${expected}, got ${actual}`);
  }
}
