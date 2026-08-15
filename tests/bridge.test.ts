/**
 * The ordering guarantee and the audit trail.
 *
 * The single most important assertion here is that a governor refusal never
 * reaches the chain. If that ever regresses, the system still appears to work
 * — spends get refused — while quietly paying fees to discover what the
 * governor already knew.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Keypair } from "@stellar/stellar-sdk";

import { execute } from "@/bridge";
import type { AgentPolicy, Grounding, Mandate, RouteInput, SpendProposal } from "@/governor/types";
import { createLedger } from "@/ledger";

const NOW = new Date("2026-08-15T00:00:00.000Z");
const TX = "b".repeat(64);

const policy: AgentPolicy = {
  agent: "research-agent",
  autoExecuteCap: "25.00",
  currency: "USD",
  allowedMerchants: ["api.example.com"],
  requiresGroundedPolicy: false,
};

const mandates: Mandate[] = [
  {
    id: "m-1",
    scope: "listed",
    merchantUrl: "https://api.example.com/reports",
    remaining: "500.00",
    currency: "USD",
    validUntil: "2026-12-01T00:00:00.000Z",
    frequency: "monthly",
  },
];

const grounding: Grounding = { cited: true, citations: [{ source: "policy-v4", excerpt: "ok" }] };

function proposal(over: Partial<SpendProposal> = {}): SpendProposal {
  return {
    id: "p-1",
    agent: "research-agent",
    kind: "purchase",
    merchant: { name: "API", url: "https://api.example.com/reports", country: "US" },
    total: "10.00",
    currency: "USD",
    items: [{ description: "report", unit_price: "10.00", quantity: 1 }],
    rationale: "needed",
    ...over,
  };
}

const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  proposal: proposal(),
  policy,
  mandates,
  grounding,
  now: NOW,
  ...over,
});

function ledger() {
  return createLedger({ signer: Keypair.random(), now: () => NOW });
}

describe("bridge — the chain is asked last, or not at all", () => {
  it("never asks the chain about a spend the governor refused", async () => {
    let asked = false;
    const outcome = await execute(
      { ledger: ledger() },
      input({
        proposal: proposal({ merchant: { name: "X", url: "https://elsewhere.test/x", country: "US" } }),
      }),
      async () => {
        asked = true;
        return { paid: true, settlement: { transaction: TX } };
      },
    );

    assert.equal(outcome.kind, "refused-off-chain");
    assert.equal(asked, false, "a blocked proposal must not reach the chain");
  });

  it("settles when both keys agree", async () => {
    const outcome = await execute({ ledger: ledger() }, input(), async () => ({
      paid: true,
      settlement: { transaction: TX },
    }));

    assert.equal(outcome.kind, "settled");
    if (outcome.kind === "settled") assert.equal(outcome.transaction, TX);
  });

  it("records a chain refusal rather than throwing it onward", async () => {
    const outcome = await execute({ ledger: ledger() }, input(), async () => {
      throw new Error("resource fee exceeds this facilitator's ceiling");
    });

    // The chain declining a governor-approved spend is the system working.
    assert.equal(outcome.kind, "refused-on-chain");
  });

  it("writes both authorities into one ledger", async () => {
    const log = ledger();
    await execute({ ledger: log }, input(), async () => ({
      paid: true,
      settlement: { transaction: TX },
    }));

    const authorities = log.entries().map((e) => e.authority);
    assert.deepEqual(authorities, ["governor", "chain"]);
  });

  it("holds an over-cap spend for a person instead of refusing it", async () => {
    const outcome = await execute(
      { ledger: ledger() },
      input({
        proposal: proposal({
          total: "500.00",
          items: [{ description: "report", unit_price: "500.00", quantity: 1 }],
        }),
      }),
      async () => ({ paid: true, settlement: { transaction: TX } }),
    );

    assert.equal(outcome.kind, "held-for-approval");
  });
});

describe("ledger — tamper evidence", () => {
  const entry = { authority: "governor" as const, proposalId: "p-1", lane: "auto" as const, reasons: [], amountMinor: 1000, currency: "USD" };

  it("verifies a chain it wrote", () => {
    const log = ledger();
    log.append(entry);
    log.append({ ...entry, proposalId: "p-2" });

    const report = log.verify();
    assert.equal(report.valid, true);
    if (report.valid) assert.equal(report.length, 2);
  });

  it("names the entry whose contents changed after signing", () => {
    const log = ledger();
    log.append(entry);
    log.append({ ...entry, proposalId: "p-2" });

    // Reach in and edit history, as an attacker with file access would.
    (log.entries()[0] as { amountMinor: number }).amountMinor = 1;

    const report = log.verify();
    assert.equal(report.valid, false);
    if (!report.valid) {
      assert.equal(report.failedAt, 0);
      assert.match(report.reason, /changed after signing/);
    }
  });

  it("detects an entry spliced out of the middle", () => {
    const log = ledger();
    log.append(entry);
    log.append({ ...entry, proposalId: "p-2" });
    log.append({ ...entry, proposalId: "p-3" });

    (log.entries() as unknown as unknown[]).splice(1, 1);

    const report = log.verify();
    assert.equal(report.valid, false);
    if (!report.valid) assert.match(report.reason, /points at/);
  });

  it("chains each entry to the one before it", () => {
    const log = ledger();
    const a = log.append(entry);
    const b = log.append({ ...entry, proposalId: "p-2" });

    assert.equal(b.prevHash, a.hash);
    assert.notEqual(a.hash, b.hash);
  });
});
