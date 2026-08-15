/**
 * The gateway's contract with vellar-sdk, held in place by tests.
 *
 * These assert the wire shapes transcribed from the SDK's own HTTP clients. If
 * one of them fails after an SDK upgrade, the contract moved — that is the
 * signal this file exists to give, and it is cheaper to receive here than at a
 * passkey prompt.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { corsHeaders, toErrorResponse } from "@/gateway/http";
import {
  POLICY_TEMPLATES,
  createUnconfiguredPolicyDeployer,
  validateDefinition,
} from "@/gateway/policies";
import { handle, type RouterDeps } from "@/gateway/router";
import { createMemorySessionStore } from "@/gateway/store";
import { createUnconfiguredSubmitter } from "@/gateway/submitter";
import { GatewayError, type Network } from "@/gateway/types";

const OWNER = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const CONTRACT = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

function deps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  let n = 0;
  return {
    sessions: createMemorySessionStore({
      newSessionId: () => `session-${++n}`,
      now: () => new Date("2026-08-14T00:00:00.000Z"),
    }),
    submitter: createUnconfiguredSubmitter(),
    policies: createUnconfiguredPolicyDeployer(),
    ...overrides,
  };
}

async function caught(fn: () => Promise<unknown>): Promise<GatewayError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof GatewayError, `expected GatewayError, got ${error}`);
    return error;
  }
  assert.fail("expected the call to throw");
}

describe("wallet routes — the shapes vellar-sdk sends and reads", () => {
  it("creates a wallet and returns only a sessionId", async () => {
    const d = deps();
    const result = await handle(d, {
      method: "POST",
      path: "/wallet/create",
      body: { keyId: "key-1", contractId: CONTRACT, network: "testnet" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { sessionId: "session-1" });
  });

  it("resolves a known passkey back to its smart account", async () => {
    const d = deps();
    await handle(d, {
      method: "POST",
      path: "/wallet/create",
      body: { keyId: "key-1", contractId: CONTRACT, network: "testnet" },
    });

    const result = await handle(d, {
      method: "POST",
      path: "/wallet/connect",
      body: { keyId: "key-1", network: "testnet" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { contractId: CONTRACT, sessionId: "session-1" });
  });

  it("answers an unknown passkey with 404, which the SDK reads as undefined", async () => {
    const result = await handle(deps(), {
      method: "POST",
      path: "/wallet/connect",
      body: { keyId: "never-seen", network: "testnet" },
    });

    // Not a thrown error: `lookupContractId` maps 404 to undefined and any
    // other non-2xx to a raised WalletApiError.
    assert.equal(result.status, 404);
  });

  it("scopes the mapping by network, so a testnet passkey never resolves on mainnet", async () => {
    const d = deps();
    await handle(d, {
      method: "POST",
      path: "/wallet/create",
      body: { keyId: "key-1", contractId: CONTRACT, network: "testnet" },
    });

    const result = await handle(d, {
      method: "POST",
      path: "/wallet/connect",
      body: { keyId: "key-1", network: "mainnet" },
    });

    assert.equal(result.status, 404);
  });

  it("returns the network hash from a submitted envelope", async () => {
    const submitted: Array<{ signedXdr: string; network: Network }> = [];
    const d = deps({
      submitter: {
        async submit(input) {
          submitted.push(input);
          return { hash: "abc123" };
        },
      },
    });

    const result = await handle(d, {
      method: "POST",
      path: "/wallet/submit",
      body: { signedXdr: "AAAA…", network: "testnet" },
    });

    assert.deepEqual(result.body, { hash: "abc123" });
    assert.deepEqual(submitted, [{ signedXdr: "AAAA…", network: "testnet" }]);
  });

  it("refuses submission with 503 when no relayer is configured", async () => {
    const error = await caught(() =>
      handle(deps(), {
        method: "POST",
        path: "/wallet/submit",
        body: { signedXdr: "AAAA…", network: "testnet" },
      }),
    );

    assert.equal(error.status, 503);
    assert.equal(error.code, "not_configured");
  });
});

describe("wallet routes — the refusals", () => {
  it("refuses an unknown network rather than defaulting to one", async () => {
    const error = await caught(() =>
      handle(deps(), {
        method: "POST",
        path: "/wallet/create",
        body: { keyId: "key-1", contractId: CONTRACT, network: "futurenet" },
      }),
    );

    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_request");
  });

  it("refuses a missing keyId", async () => {
    const error = await caught(() =>
      handle(deps(), {
        method: "POST",
        path: "/wallet/create",
        body: { contractId: CONTRACT, network: "testnet" },
      }),
    );

    assert.equal(error.status, 400);
    assert.match(error.message, /keyId/);
  });

  it("refuses a non-object body", async () => {
    const error = await caught(() =>
      handle(deps(), { method: "POST", path: "/wallet/create", body: ["not", "an", "object"] }),
    );

    assert.equal(error.code, "invalid_body");
  });

  it("refuses the wrong method on a known path", async () => {
    const error = await caught(() => handle(deps(), { method: "GET", path: "/wallet/create" }));
    assert.equal(error.status, 405);
  });

  it("404s an unknown route", async () => {
    const error = await caught(() => handle(deps(), { method: "POST", path: "/wallet/nope" }));
    assert.equal(error.status, 404);
    assert.equal(error.code, "unknown_route");
  });

  it("treats a trailing slash as the same route", async () => {
    const result = await handle(deps(), {
      method: "POST",
      path: "/wallet/create/",
      body: { keyId: "key-1", contractId: CONTRACT, network: "testnet" },
    });
    assert.equal(result.status, 200);
  });
});

describe("policy routes", () => {
  it("lists the templates the gateway will honour", async () => {
    const result = await handle(deps(), { method: "GET", path: "/policies/templates" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { templates: POLICY_TEMPLATES });
  });

  it("validates a well-formed spending limit", async () => {
    const result = await handle(deps(), {
      method: "POST",
      path: "/policies/validate",
      body: { version: "1", type: "spending_limit", owners: [OWNER], spendingLimits: { dailyXlm: "100" } },
    });

    assert.deepEqual(result.body, { valid: true });
  });

  it("refuses to generate from an invalid definition, with field errors the SDK surfaces", async () => {
    const error = await caught(() =>
      handle(deps(), {
        method: "POST",
        path: "/policies/generate",
        body: {
          network: "testnet",
          definition: { version: "1", type: "spending_limit", owners: [OWNER], spendingLimits: {} },
        },
      }),
    );

    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_definition");
    // `payload.errors` is what PolicyApiError carries through to the caller.
    assert.ok(error.fieldErrors && error.fieldErrors.length > 0);
  });

  it("routes an instance simulate to the deployer with the policy id decoded", async () => {
    const seen: Array<{ policyId: string; wallet: string }> = [];
    const d = deps({
      policies: {
        ...createUnconfiguredPolicyDeployer(),
        async simulate(input) {
          seen.push(input);
          return { ok: true, detail: "would attach" };
        },
      },
    });

    const result = await handle(d, {
      method: "POST",
      path: "/policies/pol%2F1/simulate",
      body: { wallet: CONTRACT },
    });

    assert.deepEqual(result.body, { ok: true, detail: "would attach" });
    assert.deepEqual(seen, [{ policyId: "pol/1", wallet: CONTRACT }]);
  });

  it("does not capture /policies/deploy as a policy id", async () => {
    // `/policies/deploy` and `/policies/:id/simulate` are both two segments
    // under /policies; the fixed path must win.
    const error = await caught(() =>
      handle(deps(), {
        method: "POST",
        path: "/policies/deploy",
        body: { policyId: "p1", txHash: "t1", contractId: CONTRACT },
      }),
    );

    // Reaches the deployer (503), rather than 404ing as an unknown instance route.
    assert.equal(error.code, "not_configured");
  });
});

describe("definition validation", () => {
  it("rejects an unknown template type rather than passing it through", () => {
    const result = validateDefinition({ version: "1", type: "anything_goes", owners: [OWNER] });
    assert.equal(result.valid, false);
    assert.ok(result.errors?.some((e) => e.includes("type must be one of")));
  });

  it("rejects a spending limit of zero", () => {
    const result = validateDefinition({
      version: "1",
      type: "spending_limit",
      owners: [OWNER],
      spendingLimits: { dailyXlm: "0" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors?.some((e) => e.includes("greater than zero")));
  });

  it("rejects a negative or non-decimal limit", () => {
    for (const amount of ["-5", "1e3", "abc", ""]) {
      const result = validateDefinition({
        version: "1",
        type: "spending_limit",
        owners: [OWNER],
        spendingLimits: { dailyXlm: amount },
      });
      assert.equal(result.valid, false, `${JSON.stringify(amount)} should be refused`);
    }
  });

  it("rejects an owner that is not a Stellar address", () => {
    const result = validateDefinition({
      version: "1",
      type: "spending_limit",
      owners: ["0xdeadbeef"],
      spendingLimits: { dailyXlm: "1" },
    });
    assert.equal(result.valid, false);
  });

  it("accepts a contract address as an owner", () => {
    const result = validateDefinition({
      version: "1",
      type: "verified_only",
      owners: [CONTRACT],
    });
    assert.equal(result.valid, true);
  });
});

describe("http adapter", () => {
  it("renders a GatewayError into the body both SDK clients read", () => {
    const { status, body } = toErrorResponse(
      new GatewayError(400, "invalid_definition", "nope", ["owners must be a non-empty array"]),
    );

    assert.equal(status, 400);
    // WalletApiError reads message + error; PolicyApiError also reads errors.
    assert.equal(body.message, "nope");
    assert.equal(body.error, "invalid_definition");
    assert.deepEqual(body.errors, ["owners must be a non-empty array"]);
  });

  it("does not leak internals from an unexpected failure", () => {
    const { status, body } = toErrorResponse(new Error("relayer key sk-live-abc123 rejected"));

    assert.equal(status, 500);
    assert.equal(body.error, "internal_error");
    assert.ok(!body.message.includes("sk-live"));
  });

  it("names an exact CORS origin and varies on it", () => {
    const headers = corsHeaders("https://app.example.com");
    assert.equal(headers["access-control-allow-origin"], "https://app.example.com");
    assert.equal(headers["vary"], "origin");
  });
});
